/**
 * FMP date strings <-> the contract's Unix seconds.
 *
 * FMP's daily rows carry `date: "YYYY-MM-DD"`, a New York civil date with no time and
 * no zone. The contract stamps a `1D` bar at that session's 00:00 America/New_York in
 * Unix seconds (engine invariant 3), so this is the one place a date string becomes a
 * `time`. All zone arithmetic is delegated to `../calendar` (Intl-based); there is no
 * UTC offset anywhere in this file, because the offset is -5 or -4 depending on DST.
 */
import type { UnixSeconds } from '@shared/types';
import { civilToDay, dayStartUnix, dayToCivil } from '../calendar';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Day number (days since 1970-01-01 of the civil date) of a `YYYY-MM-DD` string, or undefined if malformed. */
export function parseCivilDate(date: string): number | undefined {
  const m = DATE_RE.exec(date);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dayNumber = civilToDay(year, month, day);
  // Round-trip rejects impossible dates such as 2025-02-30, which civilToDay would roll over.
  const back = dayToCivil(dayNumber);
  return back.year === year && back.month === month && back.day === day ? dayNumber : undefined;
}

/** 00:00 New York of a `YYYY-MM-DD` date, Unix seconds. Undefined when the date is malformed. */
export function dateToNySeconds(date: string): UnixSeconds | undefined {
  const dayNumber = parseCivilDate(date);
  return dayNumber === undefined ? undefined : dayStartUnix(dayNumber);
}

export function dayNumberToDate(dayNumber: number): string {
  const { year, month, day } = dayToCivil(dayNumber);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
