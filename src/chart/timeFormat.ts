import type { Time } from 'lightweight-charts';
import { INTL_LOCALE, getLocale } from '../i18n/locale';
import type { Locale } from '../i18n/locale';

/**
 * Intraday bars are labelled in the viewer's local time zone; daily/weekly bars in
 * UTC. Daily and weekly bars are stamped at 00:00 America/New_York (04:00 or 05:00
 * UTC, the same calendar date as New York), so formatting them in UTC gives the
 * right session date for every viewer. Formatting them in a western local zone
 * would show the previous date (00:00 ET is the evening before in Pacific time).
 * Intraday labels in UTC would be worse (a 09:30 ET open reads as 13:30) and
 * exchange time zones are not in the contract, hence the viewer's local zone.
 */
interface Formats {
  localTime: Intl.DateTimeFormat;
  localDateTime: Intl.DateTimeFormat;
  localDay: Intl.DateTimeFormat;
  localMonth: Intl.DateTimeFormat;
  localYear: Intl.DateTimeFormat;
  utcDate: Intl.DateTimeFormat;
  utcDay: Intl.DateTimeFormat;
  utcMonth: Intl.DateTimeFormat;
  utcYear: Intl.DateTimeFormat;
}

function makeFormats(tag: string): Formats {
  const utc = { timeZone: 'UTC' } as const;
  return {
    localTime: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false }),
    localDateTime: new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
    localDay: new Intl.DateTimeFormat(tag, { day: 'numeric' }),
    localMonth: new Intl.DateTimeFormat(tag, { month: 'short' }),
    localYear: new Intl.DateTimeFormat(tag, { year: 'numeric' }),
    utcDate: new Intl.DateTimeFormat(tag, { ...utc, year: 'numeric', month: 'short', day: 'numeric' }),
    utcDay: new Intl.DateTimeFormat(tag, { ...utc, day: 'numeric' }),
    utcMonth: new Intl.DateTimeFormat(tag, { ...utc, month: 'short' }),
    utcYear: new Intl.DateTimeFormat(tag, { ...utc, year: 'numeric' }),
  };
}

const cache = new Map<Locale, Formats>();
function formats(locale: Locale): Formats {
  let f = cache.get(locale);
  if (!f) {
    f = makeFormats(INTL_LOCALE[locale]);
    cache.set(locale, f);
  }
  return f;
}

// Mirrors lightweight-charts' TickMarkType values; kept numeric so this module has
// no runtime import from the library (and so tests don't need it).
const TICK = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 } as const;

const MS_PER_SECOND = 1000;

function toDate(time: Time): Date | null {
  // Display-only: `Date` takes milliseconds, the data is in seconds. Nothing derived
  // from this value is ever fed back into a series or a request.
  // Time may also be a BusinessDay/string; this app only ever feeds UTCTimestamps.
  return typeof time === 'number' ? new Date(time * MS_PER_SECOND) : null;
}

/** Crosshair label, in the current language. */
export function formatCrosshairTime(time: Time, intraday: boolean, locale: Locale = getLocale()): string {
  const d = toDate(time);
  if (!d) return String(time);
  const f = formats(locale);
  return (intraday ? f.localDateTime : f.utcDate).format(d);
}

/**
 * Axis tick label; `null` defers to the library default. English daily ticks use the
 * library default (it formats in UTC, which is right for daily bars). Chinese daily ticks
 * are formatted here, because the default writes English month names.
 */
export function formatTick(time: Time, tickMarkType: number, intraday: boolean, locale: Locale = getLocale()): string | null {
  if (!intraday && locale === 'en') return null;
  const d = toDate(time);
  if (!d) return null;
  const f = formats(locale);
  switch (tickMarkType) {
    case TICK.Year:
      return (intraday ? f.localYear : f.utcYear).format(d);
    case TICK.Month:
      return (intraday ? f.localMonth : f.utcMonth).format(d);
    case TICK.DayOfMonth:
      return (intraday ? f.localDay : f.utcDay).format(d);
    default:
      return intraday ? f.localTime.format(d) : f.utcDay.format(d);
  }
}
