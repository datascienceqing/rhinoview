/**
 * US equity market calendar, in "day numbers".
 *
 * A *day number* is the count of days since 1970-01-01 of a **New York civil date**
 * (so it is independent of any UTC offset). Everything in the engine is keyed by day
 * number; Unix seconds only appear at the edges, via `Intl.DateTimeFormat` with
 * `timeZone: 'America/New_York'`. No UTC offset is hardcoded anywhere in this file.
 *
 * Rules implemented (applied uniformly to every year; this is a stand-in feed, not a
 * historical archive):
 *  - Regular session 09:30-16:00 ET, Mon-Fri.
 *  - Closed: New Year's Day (Saturday is NOT observed on the Friday), MLK Day,
 *    Washington's Birthday, Good Friday, Memorial Day, Juneteenth (2022+),
 *    Independence Day, Labor Day, Thanksgiving, Christmas. A Saturday holiday is
 *    observed on Friday, a Sunday holiday on Monday.
 *  - Early 13:00 close: day after Thanksgiving, 24 Dec and 3 Jul when they are
 *    weekdays that are not themselves holidays.
 *  - A handful of one-off closures (9/11, Sandy, national days of mourning).
 */

const NY_TZ = 'America/New_York';

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of a Unix instant in America/New_York. */
export function nyParts(unixSeconds: number): NyParts {
  const out: NyParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of nyFormat.formatToParts(new Date(Math.floor(unixSeconds) * 1000))) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
      case 'second':
        out.second = Number(p.value);
        break;
      default:
        break;
    }
  }
  return out;
}

/** New York's UTC offset (seconds, negative) at a Unix instant: -18000 or -14400. */
export function nyOffsetSeconds(unixSeconds: number): number {
  const p = nyParts(unixSeconds);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return wallAsUtc - Math.floor(unixSeconds);
}

// ── civil date arithmetic (Howard Hinnant's algorithms) ─────────────────────────

export function civilToDay(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function dayToCivil(dayNumber: number): { year: number; month: number; day: number } {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday. */
export function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/** The Monday on or before this day. */
export function mondayOf(dayNumber: number): number {
  return dayNumber - weekdayOf(dayNumber);
}

/** The New York civil date containing a Unix instant, as a day number. */
export function nyDayOf(unixSeconds: number): number {
  const p = nyParts(unixSeconds);
  return civilToDay(p.year, p.month, p.day);
}

// ── wall clock → Unix ─────────────────────────────────────────────────────────

/**
 * Unix seconds for a New York wall-clock time. Two-pass so the answer is right even
 * when the guess lands on the other side of a DST change. Never called with a time
 * inside the 02:00-03:00 gap/overlap (sessions and midnight are nowhere near it).
 */
export function nyWallToUnix(dayNumber: number, secondOfDay: number): number {
  const wall = dayNumber * 86400 + secondOfDay;
  const firstOffset = nyOffsetSeconds(wall + 5 * 3600);
  const guess = wall - firstOffset;
  const secondOffset = nyOffsetSeconds(guess);
  return secondOffset === firstOffset ? guess : wall - secondOffset;
}

const dayStartCache = new Map<number, number>();
const sessionOpenCache = new Map<number, number>();

/** 00:00 New York of a civil date, Unix seconds. This is a `1D` bar's `time`. */
export function dayStartUnix(dayNumber: number): number {
  let v = dayStartCache.get(dayNumber);
  if (v === undefined) {
    v = nyWallToUnix(dayNumber, 0);
    dayStartCache.set(dayNumber, v);
  }
  return v;
}

export const SESSION_OPEN_SECOND = 9 * 3600 + 30 * 60;
export const FULL_SESSION_MINUTES = 390;
export const EARLY_SESSION_MINUTES = 210;

/** 09:30 New York of a civil date, Unix seconds. */
export function sessionOpenUnix(dayNumber: number): number {
  let v = sessionOpenCache.get(dayNumber);
  if (v === undefined) {
    v = nyWallToUnix(dayNumber, SESSION_OPEN_SECOND);
    sessionOpenCache.set(dayNumber, v);
  }
  return v;
}

// ── holidays ───────────────────────────────────────────────────────────────────

/** Day number of the nth (1-based) given weekday (0 = Mon) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = civilToDay(year, month, 1);
  const delta = (weekday - weekdayOf(first) + 7) % 7;
  return first + delta + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const nextMonthFirst = month === 12 ? civilToDay(year + 1, 1, 1) : civilToDay(year, month + 1, 1);
  const last = nextMonthFirst - 1;
  return last - ((weekdayOf(last) - weekday + 7) % 7);
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easterDay(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return civilToDay(year, month, day);
}

/** Saturday → Friday, Sunday → Monday. */
function observed(dayNumber: number): number {
  const wd = weekdayOf(dayNumber);
  if (wd === 5) return dayNumber - 1;
  if (wd === 6) return dayNumber + 1;
  return dayNumber;
}

const ONE_OFF_CLOSURES: readonly [number, number, number][] = [
  [2001, 9, 11],
  [2001, 9, 12],
  [2001, 9, 13],
  [2001, 9, 14],
  [2004, 6, 11], // national day of mourning, Reagan
  [2007, 1, 2], // national day of mourning, Ford
  [2012, 10, 29], // Hurricane Sandy
  [2012, 10, 30],
  [2018, 12, 5], // national day of mourning, G.H.W. Bush
  [2025, 1, 9], // national day of mourning, Carter
];

interface YearCalendar {
  holidays: Set<number>;
  earlyCloses: Set<number>;
}

const yearCache = new Map<number, YearCalendar>();

function yearCalendar(year: number): YearCalendar {
  const cached = yearCache.get(year);
  if (cached) return cached;

  const holidays = new Set<number>();
  const newYear = civilToDay(year, 1, 1);
  // When 1 Jan is a Saturday the exchange stays open on the preceding Friday.
  if (weekdayOf(newYear) !== 5) holidays.add(observed(newYear));
  if (year >= 1998) holidays.add(nthWeekday(year, 1, 0, 3)); // MLK Day
  holidays.add(nthWeekday(year, 2, 0, 3)); // Washington's Birthday
  holidays.add(easterDay(year) - 2); // Good Friday
  holidays.add(lastWeekday(year, 5, 0)); // Memorial Day
  if (year >= 2022) holidays.add(observed(civilToDay(year, 6, 19))); // Juneteenth
  holidays.add(observed(civilToDay(year, 7, 4)));
  holidays.add(nthWeekday(year, 9, 0, 1)); // Labor Day
  const thanksgiving = nthWeekday(year, 11, 3, 4);
  holidays.add(thanksgiving);
  holidays.add(observed(civilToDay(year, 12, 25)));
  for (const [y, m, d] of ONE_OFF_CLOSURES) if (y === year) holidays.add(civilToDay(y, m, d));

  const earlyCloses = new Set<number>();
  const candidates = [thanksgiving + 1, civilToDay(year, 12, 24), civilToDay(year, 7, 3)];
  for (const c of candidates) {
    if (weekdayOf(c) <= 4 && !holidays.has(c)) earlyCloses.add(c);
  }

  const cal = { holidays, earlyCloses };
  yearCache.set(year, cal);
  return cal;
}

export function isHoliday(dayNumber: number): boolean {
  return yearCalendar(dayToCivil(dayNumber).year).holidays.has(dayNumber);
}

export function isEarlyClose(dayNumber: number): boolean {
  return yearCalendar(dayToCivil(dayNumber).year).earlyCloses.has(dayNumber);
}

/** Minutes in the regular session of this day: 390, 210 (early close), or 0 (closed). */
export function sessionMinutes(dayNumber: number): number {
  if (weekdayOf(dayNumber) > 4) return 0;
  const cal = yearCalendar(dayToCivil(dayNumber).year);
  if (cal.holidays.has(dayNumber)) return 0;
  return cal.earlyCloses.has(dayNumber) ? EARLY_SESSION_MINUTES : FULL_SESSION_MINUTES;
}

export function isTradingDay(dayNumber: number): boolean {
  return sessionMinutes(dayNumber) > 0;
}

/**
 * Index of a weekday in a calendar with weekends removed (5 slots per week). The
 * price path is indexed by slot, not by day, so Monday's gap is one overnight gap
 * like any other rather than a three-day one.
 */
export function tradingSlot(dayNumber: number): number {
  return Math.floor((dayNumber + 3) / 7) * 5 + Math.min(weekdayOf(dayNumber), 4);
}
