/**
 * my-rest-next — RRule occurrence finder.
 *
 * Supports the subset of iCalendar RRule frequency-based rules documented in the
 * README: DAILY, WEEKLY, MONTHLY, and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY,
 * BYMONTHDAY, and BYMONTH filters. WKST is recognised but assumed to be MO.
 *
 * Dates are carried as plain JavaScript numbers (millis since epoch) at the
 * boundary and as Date objects internally so the implementation can lean on the
 * standard library for month/year arithmetic. The choice keeps the public API
 * trivial to serialise and avoids pulling in a date library.
 */

// DAY_MILLIS is not used for recurrence math (we always go through Date objects),
// but the callers that want to step day-by-day after finding occurrences benefit
// from having this constant exported alongside the finder.
const MS_PER_DAY = 86400000;

/**
 * Map two-letter iCalendar weekday codes to JavaScript's 0-6 Sunday-origin week.
 */
const WEEKDAY_CODE_TO_JS = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const WEEKDAY_JS_TO_CODE = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const KNOWN_PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "WKST",
]);

/**
 * Parse an iCalendar DTSTART value such as 20200101T080000Z or
 * 20200101T080000. Local times are interpreted in the host's local zone for
 * simplicity — we deliberately do not embed a tz database.
 */
export function parseDTStart(value) {
  if (typeof value !== "string" || value.length < 15) {
    throw new RangeError("Invalid DTSTART: expected YYYYMMDDTHHMMSS[Z]");
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (value.charAt(8) !== "T") {
    throw new RangeError("Invalid DTSTART: missing 'T' separator");
  }
  const hour = Number(value.slice(9, 11));
  const minute = Number(value.slice(11, 13));
  const second = Number(value.slice(13, 15));
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    throw new RangeError("Invalid DTSTART: non-numeric date component");
  }
  const isUtc = value.charAt(15) === "Z";
  if (isUtc) {
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * Parse an iCalendar UNTIL value, which may be a date or a UTC date-time.
 */
function parseUntil(raw) {
  if (raw.length === 8) {
    // date form, e.g. 20200101 — treat as end-of-day UTC for an inclusive bound
    const y = Number(raw.slice(0, 4));
    const m = Number(raw.slice(4, 6));
    const d = Number(raw.slice(6, 8));
    return Date.UTC(y, m - 1, d, 23, 59, 59);
  }
  return parseDTStart(raw);
}

/**
 * Parse the FREQ and the supporting parts of an RRULE string. We deliberately
 * support only the documented subset; an unknown part throws rather than being
 * silently ignored, so callers do not ship rules that produce surprising
 * results.
 */
export function parseRRule(rule) {
  if (typeof rule !== "string") {
    throw new RangeError("RRULE must be a string");
  }
  const cleaned = rule.trim().replace(/^RRULE:/i, "");
  const parts = cleaned.split(";");
  const result = { freq: undefined, interval: 1 };
  for (const part of parts) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new RangeError(`Invalid RRULE part: ${part}`);
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    if (!KNOWN_PARTS.has(key)) throw new RangeError(`Unsupported RRULE part: ${key}`);
    switch (key) {
      case "FREQ": {
        const f = val.toUpperCase();
        if (f !== "DAILY" && f !== "WEEKLY" && f !== "MONTHLY" && f !== "YEARLY") {
          throw new RangeError(`Unsupported FREQ: ${f}`);
        }
        result.freq = f;
        break;
      }
      case "INTERVAL": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) {
          throw new RangeError(`Invalid INTERVAL: ${val}`);
        }
        result.interval = n;
        break;
      }
      case "COUNT": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) {
          throw new RangeError(`Invalid COUNT: ${val}`);
        }
        result.count = n;
        break;
      }
      case "UNTIL": {
        result.until = parseUntil(val);
        break;
      }
      case "BYDAY": {
        result.byday = val.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
        break;
      }
      case "BYMONTHDAY": {
        result.bymonthday = val.split(",").map((s) => Number(s.trim()));
        break;
      }
      case "BYMONTH": {
        result.bymonth = val.split(",").map((s) => Number(s.trim()));
        break;
      }
      case "WKST": {
        result.wkst = val.trim().toUpperCase();
        break;
      }
      default:
        throw new RangeError(`Unsupported RRULE part: ${key}`);
    }
  }
  if (result.freq === undefined) throw new RangeError("RRULE missing FREQ");
  return result;
}

/**
 * Convert a JS week index (0=Sun..6=Sat) to the two-letter iCal code.
 */
function jsWeekdayToCode(jsDay) {
  return WEEKDAY_JS_TO_CODE[jsDay];
}

/**
 * Return the number of days in the given month (1-12) of the given year.
 */
function daysInMonth(year, month) {
  // Date with day 0 of next month yields last day of current month.
  return new Date(year, month, 0).getDate();
}

/**
 * Resolve a possibly-negative BYMONTHDAY value (e.g. -1 for the last day of
 * the month) against the concrete year/month.
 */
function resolveMonthday(year, month, monthday) {
  const dim = daysInMonth(year, month);
  if (monthday > 0) {
    return monthday <= dim ? monthday : null;
  }
  const resolved = dim + monthday + 1;
  return resolved >= 1 ? resolved : null;
}

/**
 * Apply the BYDAY filter to a set of candidate dates within a single month.
 * Returns the matching days-of-month.
 */
function bydayMatchesInMonth(year, month, weekdayCodes) {
  const dim = daysInMonth(year, month);
  const out = [];
  for (let day = 1; day <= dim; day++) {
    const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const code = jsWeekdayToCode(jsDay);
    if (weekdayCodes.includes(code)) {
      out.push(day);
    }
  }
  return out;
}

/**
 * Check whether the given UTC millis fall before the rule's UNTIL bound.
 */
function isBeforeUntil(millis, untilMillis) {
  if (untilMillis === undefined) return true;
  return millis <= untilMillis;
}

/**
 * Build a Date for the given Y/M/D at the same UTC time-of-day as the seed.
 * We use UTC throughout the recurrence engine so that month arithmetic is
 * deterministic across host time zones — the only place local time enters is
 * parseDTStart, which is documented behaviour.
 */
function dateAtYmdKeepingTime(seedMillis, year, month, day) {
  const seed = new Date(seedMillis);
  return Date.UTC(year, month - 1, day, seed.getUTCHours(), seed.getUTCMinutes(), seed.getUTCSeconds());
}

/**
 * Given a seed date and a parsed rule, generate occurrences as millisecond
 * timestamps. The generator yields in ascending chronological order.
 */
export function* computeOccurrences(dtStartMillis, parsed) {
  const seed = new Date(dtStartMillis);
  const startYear = seed.getUTCFullYear();
  const startMonth = seed.getUTCMonth() + 1;
  const startDay = seed.getUTCDate();

  const MAX_PERIODS = 100000;

  const frequency = parsed.freq;
  const interval = parsed.interval;

  let emitted = 0;
  if (parsed.count !== undefined && parsed.count === 0) return;

  if (frequency === "DAILY") {
    let dayOffset = 0;
    let periods = 0;
    while (periods < MAX_PERIODS) {
      const dateMillis = Date.UTC(startYear, startMonth - 1, startDay + dayOffset, seed.getUTCHours(), seed.getUTCMinutes(), seed.getUTCSeconds());
      if (!isBeforeUntil(dateMillis, parsed.until)) break;

      const date = new Date(dateMillis);
      if (matchesDailyFilters(date, parsed)) {
        yield dateMillis;
        emitted++;
        if (parsed.count !== undefined && emitted >= parsed.count) return;
      }
      dayOffset += interval;
      periods++;
    }
    return;
  }

  if (frequency === "WEEKLY") {
    let dayOffset = 0;
    let periods = 0;
    while (periods < MAX_PERIODS) {
      const dateMillis = Date.UTC(startYear, startMonth - 1, startDay + dayOffset, seed.getUTCHours(), seed.getUTCMinutes(), seed.getUTCSeconds());
      if (!isBeforeUntil(dateMillis, parsed.until)) break;

      const date = new Date(dateMillis);
      const inEmitWeek = Math.floor(dayOffset / 7) % interval === 0;
      if (inEmitWeek && matchesWeeklyFilters(date, parsed)) {
        yield dateMillis;
        emitted++;
        if (parsed.count !== undefined && emitted >= parsed.count) return;
      }
      dayOffset++;
      periods++;
    }
    return;
  }

  if (frequency === "MONTHLY") {
    let year = startYear;
    let month = startMonth;
    let periods = 0;
    while (periods < MAX_PERIODS) {
      for (const millis of monthlyCandidates(year, month, seed, parsed)) {
        if (millis < dtStartMillis) continue;
        if (!isBeforeUntil(millis, parsed.until)) return;
        yield millis;
        emitted++;
        if (parsed.count !== undefined && emitted >= parsed.count) return;
      }
      month += interval;
      while (month > 12) {
        month -= 12;
        year++;
      }
      periods++;
    }
    return;
  }

  if (frequency === "YEARLY") {
    let year = startYear;
    let periods = 0;
    while (periods < MAX_PERIODS) {
      for (const millis of yearlyCandidates(year, seed, parsed)) {
        if (millis < dtStartMillis) continue;
        if (!isBeforeUntil(millis, parsed.until)) return;
        yield millis;
        emitted++;
        if (parsed.count !== undefined && emitted >= parsed.count) return;
      }
      year += interval;
      periods++;
    }
    return;
  }

  throw new RangeError(`Unsupported FREQ: ${frequency}`);
}

/**
 * DAILY filter: BYDAY narrows to specific weekdays if present.
 */
function matchesDailyFilters(date, parsed) {
  if (parsed.byday) {
    const code = jsWeekdayToCode(date.getUTCDay());
    if (!parsed.byday.includes(code)) return false;
  }
  return true;
}

/**
 * WEEKLY filter: same as DAILY but separated for clarity.
 */
function matchesWeeklyFilters(date, parsed) {
  if (parsed.byday) {
    const code = jsWeekdayToCode(date.getUTCDay());
    if (!parsed.byday.includes(code)) return false;
  }
  return true;
}

/**
 * Yields candidate occurrence timestamps within a single month for MONTHLY
 * rules, in ascending order.
 */
function* monthlyCandidates(year, month, seed, parsed) {
  const seedDay = seed.getUTCDate();
  const candidateDays = new Set();

  if (parsed.bymonthday) {
    for (const md of parsed.bymonthday) {
      const resolved = resolveMonthday(year, month, md);
      if (resolved !== null) candidateDays.add(resolved);
    }
  }

  if (parsed.byday) {
    for (const d of bydayMatchesInMonth(year, month, parsed.byday)) {
      candidateDays.add(d);
    }
  }

  if (!parsed.bymonthday && !parsed.byday) {
    const dim = daysInMonth(year, month);
    if (seedDay <= dim) {
      candidateDays.add(seedDay);
    } else {
      return;
    }
  }

  for (const day of [...candidateDays].sort((a, b) => a - b)) {
    yield dateAtYmdKeepingTime(seed.getTime(), year, month, day);
  }
}

/**
 * Yields candidate occurrence timestamps within a single year for YEARLY rules.
 */
function* yearlyCandidates(year, seed, parsed) {
  const seedMonth = seed.getUTCMonth() + 1;
  const seedDay = seed.getUTCDate();
  const months = parsed.bymonth ? parsed.bymonth.slice().sort((a, b) => a - b) : [seedMonth];

  for (const m of months) {
    if (parsed.bymonthday || parsed.byday) {
      for (const millis of monthlyCandidates(year, m, seed, parsed)) {
        yield millis;
      }
    } else {
      const dim = daysInMonth(year, m);
      if (seedDay <= dim) {
        yield dateAtYmdKeepingTime(seed.getTime(), year, m, seedDay);
      }
    }
  }
}

/**
 * Find the next N occurrences strictly after `afterMillis`.
 */
export function findNext(dtStartMillis, parsed, afterMillis, count = 1) {
  const out = [];
  for (const millis of computeOccurrences(dtStartMillis, parsed)) {
    if (millis <= afterMillis) continue;
    out.push(millis);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Find the previous N occurrences strictly before `beforeMillis`.
 */
export function findPrevious(dtStartMillis, parsed, beforeMillis, count = 1) {
  const seen = [];
  for (const millis of computeOccurrences(dtStartMillis, parsed)) {
    if (millis >= beforeMillis) break;
    seen.push(millis);
  }
  if (seen.length <= count) return seen;
  return seen.slice(seen.length - count);
}
