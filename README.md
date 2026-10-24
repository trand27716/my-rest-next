# my-rest-next

Computes the next or previous N occurrences of a calendar event that follows an iCalendar RRule recurrence specification.

## Usage

```js
import { parseDTStart, parseRRule, findNext, findPrevious } from "my-rest-next";

const dt = parseDTStart("20200101T080000Z");
const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=20");

// Next two occurrences after 2020-01-03T00:00:00Z
const next = findNext(dt, rule, Date.UTC(2020, 0, 3, 0, 0, 0), 2);

// Previous occurrence before 2020-01-10T00:00:00Z
const prev = findPrevious(dt, rule, Date.UTC(2020, 0, 10, 0, 0, 0), 1);
```

## Why this exists

The problem is narrow but common: you have an iCalendar `RRULE` string and an event `DTSTART`, and you need to know what comes next (or what just passed) without pulling in a full recurrence library. `my-rest-next` implements the subset of RRule that covers the overwhelming majority of real-world calendar rules — `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY` with `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, and `BYMONTH` — in a single file with zero dependencies.

The trade-off is explicit: we do not ship a time-zone database. `DTSTART` values carrying a trailing `Z` are treated as UTC and the recurrence engine runs entirely in UTC so month arithmetic is deterministic across hosts. Floating (no `Z`) values are interpreted in the host's local zone at parse time, which is correct for the common case of a server running in the same zone as the calendar's origin. If you need robust cross-zone behaviour, use a larger library.

## Edge cases you will hit

- **February 29 on a YEARLY rule.** Non-leap years are skipped rather than clamping to February 28. This matches iCalendar's "skip" semantics for dates that do not exist in a given year.
- **MONTHLY on the 31st.** Months with fewer than 31 days are skipped entirely — no silent clamping to the last day. Use `BYMONTHDAY=-1` if you want the last day of every month.
- **BYDAY without an explicit seed match.** When `BYDAY` excludes the `DTSTART` weekday, the first yielded occurrence is the first matching weekday after `DTSTART`, not `DTSTART` itself.
- **UNTIL is inclusive.** An occurrence whose timestamp equals the `UNTIL` value is emitted.
