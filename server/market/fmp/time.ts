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
import { civilToDay, dayStartUnix, dayToCivil, nyWallToUnix } from '../calendar';

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

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * An intraday `"YYYY-MM-DD HH:MM:SS"` New York wall-clock string -> Unix seconds, or undefined
 * when malformed. Read as UTC every bar would be 4-5 hours wrong, so the zone work is
 * `nyWallToUnix`'s (Intl-based, DST-aware); no offset is hardcoded here.
 */
export function dateTimeToNySeconds(value: string): UnixSeconds | undefined {
  const m = DATETIME_RE.exec(value);
  if (!m) return undefined;
  const dayNumber = parseCivilDate(m[1] ?? '');
  const h = Number(m[2]);
  const min = Number(m[3]);
  const sec = Number(m[4]);
  if (dayNumber === undefined || h > 23 || min > 59 || sec > 59) return undefined;
  return nyWallToUnix(dayNumber, h * 3600 + min * 60 + sec);
}
