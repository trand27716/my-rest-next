import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeOccurrences,
  findNext,
  findPrevious,
  parseDTStart,
  parseRRule,
} from "../src/core.js";

/**
 * Helper: convert a UTC Y/M/D H:M:S tuple to millis since epoch.
 */
function utc(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month, day, hour, minute, second);
}

/**
 * Helper: format millis as a UTC date string for readable assertion messages.
 */
function fmt(millis) {
  return new Date(millis).toISOString();
}

// --- parseDTStart --------------------------------------------------------

test("parseDTStart parses a UTC date-time with trailing Z", () => {
  assert.equal(parseDTStart("20200101T080000Z"), Date.UTC(2020, 0, 1, 8, 0, 0));
});

test("parseDTStart parses a floating (local) date-time via host zone", () => {
  const local = new Date(2020, 0, 1, 8, 0, 0).getTime();
  assert.equal(parseDTStart("20200101T080000"), local);
});

test("parseDTStart throws on missing T separator", () => {
  assert.throws(() => parseDTStart("20200101080000Z"), RangeError);
});

// --- parseRRule ----------------------------------------------------------

test("parseRRule accepts a bare FREQ=DAILY string", () => {
  const r = parseRRule("FREQ=DAILY");
  assert.equal(r.freq, "DAILY");
  assert.equal(r.interval, 1);
});

test("parseRRule accepts an RRULE:-prefixed string", () => {
  const r = parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
  assert.equal(r.freq, "WEEKLY");
  assert.equal(r.interval, 2);
  assert.deepEqual(r.byday, ["MO", "WE"]);
});

test("parseRRule throws on unknown FREQ", () => {
  assert.throws(() => parseRRule("FREQ=HOURLY"), RangeError);
});

test("parseRRule rejects non-positive INTERVAL", () => {
  assert.throws(() => parseRRule("FREQ=DAILY;INTERVAL=0"), RangeError);
  assert.throws(() => parseRRule("FREQ=DAILY;INTERVAL=-1"), RangeError);
});

test("parseRRule parses UNTIL as a date-time", () => {
  const r = parseRRule("FREQ=DAILY;UNTIL=20200105T000000Z");
  assert.equal(r.until, Date.UTC(2020, 0, 5, 0, 0, 0));
});

// --- DAILY ---------------------------------------------------------------

test("DAILY every day yields consecutive days", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    ["2020-01-01T08:00:00.000Z", "2020-01-02T08:00:00.000Z", "2020-01-03T08:00:00.000Z"],
  );
});

test("DAILY with INTERVAL=2 skips every other day", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;INTERVAL=2;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    ["2020-01-01T08:00:00.000Z", "2020-01-03T08:00:00.000Z", "2020-01-05T08:00:00.000Z"],
  );
});

test("DAILY respects UNTIL inclusive bound", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;UNTIL=20200103T080000Z");
  const out = [...computeOccurrences(dt, r)];
  assert.equal(out.length, 3);
});

// --- WEEKLY --------------------------------------------------------------

test("WEEKLY with BYDAY=MO,WE,FR yields only those weekdays", () => {
  const dt = parseDTStart("20200101T080000Z"); // Wednesday
  const r = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    [
      "2020-01-01T08:00:00.000Z", // Wed
      "2020-01-03T08:00:00.000Z", // Fri
      "2020-01-06T08:00:00.000Z", // Mon
      "2020-01-08T08:00:00.000Z", // Wed
      "2020-01-10T08:00:00.000Z", // Fri
    ],
  );
});

test("WEEKLY with INTERVAL=2 skips alternate weeks", () => {
  const dt = parseDTStart("20200101T080000Z"); // Wed
  const r = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    [
      "2020-01-01T08:00:00.000Z",
      "2020-01-15T08:00:00.000Z",
      "2020-01-29T08:00:00.000Z",
    ],
  );
});

// --- MONTHLY -------------------------------------------------------------

test("MONTHLY preserves the seed day-of-month", () => {
  const dt = parseDTStart("20200115T080000Z");
  const r = parseRRule("FREQ=MONTHLY;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    ["2020-01-15T08:00:00.000Z", "2020-02-15T08:00:00.000Z", "2020-03-15T08:00:00.000Z"],
  );
});

test("MONTHLY skips Feb 30 and does not clamp to the last day", () => {
  const dt = parseDTStart("20200130T080000Z");
  const r = parseRRule("FREQ=MONTHLY;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  // Jan 30, then Mar 30 (Feb skipped because there is no 30th), then Apr 30.
  assert.deepEqual(
    out.map(fmt),
    ["2020-01-30T08:00:00.000Z", "2020-03-30T08:00:00.000Z", "2020-04-30T08:00:00.000Z"],
  );
});

test("MONTHLY with BYMONTHDAY=-1 yields the last day of each month", () => {
  const dt = parseDTStart("20200131T080000Z");
  const r = parseRRule("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    ["2020-01-31T08:00:00.000Z", "2020-02-29T08:00:00.000Z", "2020-03-31T08:00:00.000Z"],
  );
});

// --- YEARLY --------------------------------------------------------------

test("YEARLY preserves the seed month and day", () => {
  const dt = parseDTStart("20200229T080000Z");
  const r = parseRRule("FREQ=YEARLY;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  // Feb 29 only exists in leap years; non-leap years are skipped.
  assert.deepEqual(
    out.map(fmt),
    ["2020-02-29T08:00:00.000Z", "2024-02-29T08:00:00.000Z", "2028-02-29T08:00:00.000Z"],
  );
});

test("YEARLY with BYMONTH yields only the listed months", () => {
  const dt = parseDTStart("20200115T080000Z");
  const r = parseRRule("FREQ=YEARLY;BYMONTH=2,6,10;COUNT=3");
  const out = [...computeOccurrences(dt, r)];
  assert.deepEqual(
    out.map(fmt),
    ["2020-02-15T08:00:00.000Z", "2020-06-15T08:00:00.000Z", "2020-10-15T08:00:00.000Z"],
  );
});

// --- findNext / findPrevious --------------------------------------------

test("findNext returns the next occurrence strictly after the given instant", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;COUNT=10");
  const after = utc(2020, 0, 3, 8, 0, 0);
  const out = findNext(dt, r, after, 2);
  assert.deepEqual(out.map(fmt), ["2020-01-04T08:00:00.000Z", "2020-01-05T08:00:00.000Z"]);
});

test("findNext returns fewer than count when UNTIL cuts off", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;UNTIL=20200103T080000Z");
  const out = findNext(dt, r, utc(2020, 0, 2, 8, 0, 0), 5);
  assert.deepEqual(out.map(fmt), ["2020-01-03T08:00:00.000Z"]);
});

test("findPrevious returns the most recent occurrences before the given instant", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;COUNT=10");
  const before = utc(2020, 0, 5, 8, 0, 0);
  const out = findPrevious(dt, r, before, 2);
  // ascending order, so the most recent is the last element
  assert.deepEqual(out.map(fmt), ["2020-01-03T08:00:00.000Z", "2020-01-04T08:00:00.000Z"]);
});

test("findPrevious returns empty when no occurrences exist before the instant", () => {
  const dt = parseDTStart("20200101T080000Z");
  const r = parseRRule("FREQ=DAILY;COUNT=10");
  const out = findPrevious(dt, r, utc(2020, 0, 1, 0, 0, 0), 3);
  assert.deepEqual(out, []);
});
