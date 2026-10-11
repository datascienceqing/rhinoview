/**
 * Alert expiry (docs/ALERTS_PLAN.md, section 4.2, decision D9).
 *
 * Pure. Weeks add 7 days. Months and years add calendar months in UTC; when the target
 * month is shorter, the day clamps to its last day (Jan 31 + 1M = Feb 28 or 29).
 * The client shows the result and the server stores it, so both use this function.
 */
import { ALERT_EXPIRY_CHOICES } from '@shared/types';
import type { AlertExpiry, UnixSeconds } from '@shared/types';

const WEEK = 7 * 24 * 3600;

export function isAlertExpiry(v: unknown): v is AlertExpiry {
  return typeof v === 'string' && (ALERT_EXPIRY_CHOICES as readonly string[]).includes(v);
}

function addMonthsUtc(seconds: UnixSeconds, months: number): UnixSeconds {
  const d = new Date(seconds * 1000);
  const day = d.getUTCDate();
  const target = new Date(d.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return Math.floor(target.getTime() / 1000);
}

/** The Unix second when an alert set at `now` with `choice` expires. */
export function computeExpiresAt(now: UnixSeconds, choice: AlertExpiry): UnixSeconds {
  const count = Number(choice.slice(0, -1));
  const unit = choice.slice(-1);
  if (unit === 'w') return now + count * WEEK;
  if (unit === 'M') return addMonthsUtc(now, count);
  return addMonthsUtc(now, count * 12);
}
