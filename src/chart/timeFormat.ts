import type { Time } from 'lightweight-charts';

/**
 * Intraday bars are labelled in the viewer's local time zone; daily/weekly bars in
 * UTC. Daily and weekly bars are stamped at 00:00 America/New_York (04:00 or 05:00
 * UTC, the same calendar date as New York), so formatting them in UTC gives the
 * right session date for every viewer. Formatting them in a western local zone
 * would show the previous date (00:00 ET is the evening before in Pacific time).
 * Intraday labels in UTC would be worse (a 09:30 ET open reads as 13:30) and
 * exchange time zones are not in the contract, hence the viewer's local zone.
 */
const localTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const localDateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const localDay = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
const localMonth = new Intl.DateTimeFormat('en-US', { month: 'short' });
const localYear = new Intl.DateTimeFormat('en-US', { year: 'numeric' });
const utcDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

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

/** Crosshair label. */
export function formatCrosshairTime(time: Time, intraday: boolean): string {
  const d = toDate(time);
  if (!d) return String(time);
  return (intraday ? localDateTime : utcDate).format(d);
}

/** Axis tick label; `null` defers to the library default. */
export function formatTick(time: Time, tickMarkType: number, intraday: boolean): string | null {
  if (!intraday) return null;
  const d = toDate(time);
  if (!d) return null;
  switch (tickMarkType) {
    case TICK.Year:
      return localYear.format(d);
    case TICK.Month:
      return localMonth.format(d);
    case TICK.DayOfMonth:
      return localDay.format(d);
    default:
      return localTime.format(d);
  }
}
