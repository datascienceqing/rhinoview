/**
 * Pure conversions from FMP rows to contract types. No I/O, no clock.
 */
import type { Bar, Snapshot, UnixSeconds } from '@shared/types';
import { dayStartUnix, mondayOf, nyDayOf, sessionOpenUnix } from '../calendar';
import type { EodRow, IntradayRow, QuoteRow } from './schemas';
import { dateTimeToNySeconds, dateToNySeconds } from './time';

/**
 * FMP returns at most this many rows per request (measured: 1980 -> now returned exactly
 * 5000, oldest 2006-11-15, newest today). The rows kept are the NEWEST, which is what
 * the contract's truncation guarantee wants. A response of exactly this many rows is
 * therefore treated as clipped.
 */
export const FMP_ROW_CAP = 5000;

/**
 * FMP volume -> whole shares. FMP sometimes sends a fraction (measured 2026-10-09:
 * AAPL 5min 15:45 `320128.0681499988`, AAPL 1hour 2026-08-14 09:30 `5125954.48318`),
 * most often in the latest session but also on older 1hour bars. A share count is a
 * whole number everywhere else in the app (synthetic data, the formatter), so the
 * fraction is removed here, where FMP data enters.
 */
export function wholeShares(volume: number): number {
  return Math.round(volume);
}

/**
 * FMP daily rows -> contract daily bars: ascending, strictly increasing, no duplicates.
 *
 * FMP sends rows newest-first. Sorting (rather than blindly reversing) means the
 * guarantee holds for any input order, and a duplicated date keeps the later row.
 * Rows with a malformed date are dropped: there is no honest `time` to give them.
 */
export function eodRowsToBars(rows: readonly EodRow[]): Bar[] {
  const byTime = new Map<UnixSeconds, Bar>();
  for (const r of rows) {
    const time = dateToNySeconds(r.date);
    if (time === undefined) continue;
    byTime.set(time, {
      time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: wholeShares(r.volume),
      vwap: r.vwap,
      // FMP's EOD feed has no trade count. Null, never 0 (CONTRACT guarantee 3).
      transactions: null,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * FMP intraday rows -> bars: ascending, strictly increasing, no duplicates. Rows arrive
 * newest-first; sorting makes the guarantee independent of that. `time` is the bar's OPEN
 * (FMP's `date` is the open: 09:30 is the first 5min bar, 15:55 the last).
 * FMP has no VWAP or trade count on these rows: null, never 0. Volume is rounded (wholeShares).
 */
export function intradayRowsToBars(rows: readonly IntradayRow[]): Bar[] {
  const byTime = new Map<UnixSeconds, Bar>();
  for (const r of rows) {
    const time = dateTimeToNySeconds(r.date);
    if (time === undefined) continue;
    byTime.set(time, { time, open: r.open, high: r.high, low: r.low, close: r.close, volume: wholeShares(r.volume), vwap: null, transactions: null });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Daily bars -> weekly bars, stamped on the New York Monday exactly as the synthetic
 * engine does (a week whose Monday is a holiday is still stamped Monday).
 *
 * open is the first session's, close the last session's, high/low the max/min, volume
 * the sum. VWAP is volume-weighted over the days, rounded to 4 places like the proxy's
 * own minute aggregation, and null if any day lacks one (a partial VWAP would be a
 * plausible-looking lie). Input must be ascending; output is.
 */
export function aggregateWeekly(daily: readonly Bar[]): Bar[] {
  const weeks: Bar[] = [];
  let currentMonday: number | undefined;
  let acc: Bar | undefined;
  let vwapNumerator = 0;
  let vwapKnown = true;

  const flush = () => {
    if (!acc) return;
    acc.vwap = vwapKnown && acc.volume > 0 ? Math.round((vwapNumerator / acc.volume) * 1e4) / 1e4 : null;
    weeks.push(acc);
  };

  for (const d of daily) {
    const monday = mondayOf(nyDayOf(d.time));
    if (acc === undefined || monday !== currentMonday) {
      flush();
      currentMonday = monday;
      acc = { ...d, time: dayStartUnix(monday), vwap: null, transactions: null };
      vwapNumerator = 0;
      vwapKnown = true;
    } else {
      acc.high = Math.max(acc.high, d.high);
      acc.low = Math.min(acc.low, d.low);
      acc.close = d.close;
      acc.volume += d.volume;
    }
    if (d.vwap === null) vwapKnown = false;
    else vwapNumerator += d.vwap * d.volume;
  }
  flush();
  return weeks;
}

/** Seconds in a 4h bucket. A session holds two of them; the second one is short. */
const FOUR_HOUR_SECONDS = 4 * 3600;

/**
 * Hourly bars -> 4h bars, bucketed from each session's OPEN exactly as the synthetic
 * engine does. A normal session (09:30-16:00) gives a bar at 09:30 and a short one at
 * 13:30; an early close gives one. Buckets never span two sessions, so an overnight gap
 * cannot land inside a bar.
 *
 * 240 is a whole multiple of 60, so each 4h bar is exactly the first/last/max/min/sum of
 * its hourly bars and engine invariant 2 holds by construction — the same reason `1W` is
 * folded from daily bars here rather than fetched.
 *
 * FMP intraday rows carry no VWAP or trade count, so both stay null (never 0,
 * CONTRACT guarantee 3). Input must be ascending; output is.
 */
export function aggregateFourHour(hourly: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let currentStart: number | undefined;
  let acc: Bar | undefined;

  for (const h of hourly) {
    const open = sessionOpenUnix(nyDayOf(h.time));
    // A row before the session open (FMP has none, but the data is not ours) keeps its
    // own time as the bucket start rather than folding backwards into the prior session.
    const start = h.time < open ? h.time : open + Math.floor((h.time - open) / FOUR_HOUR_SECONDS) * FOUR_HOUR_SECONDS;
    if (acc === undefined || start !== currentStart) {
      if (acc) out.push(acc);
      currentStart = start;
      acc = { ...h, time: start, vwap: null, transactions: null };
    } else {
      acc.high = Math.max(acc.high, h.high);
      acc.low = Math.min(acc.low, h.low);
      acc.close = h.close;
      acc.volume += h.volume;
    }
  }
  if (acc) out.push(acc);
  return out;
}

/**
 * FMP `quote` row -> Snapshot.
 *
 * `changePercentage` is a PERCENTAGE (1.02022 = +1.02%); `Snapshot.changePercent` is a
 * fraction (0.0102022). Hence the / 100. The quote's `timestamp` is already Unix seconds.
 */
export function snapshotFromQuote(q: QuoteRow, delayed: boolean): Snapshot {
  return {
    symbol: q.symbol.toUpperCase(),
    price: q.price,
    change: q.change,
    changePercent: q.changePercentage === null ? null : q.changePercentage / 100,
    previousClose: q.previousClose,
    dayOpen: q.open,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    dayVolume: q.volume === null ? null : wholeShares(q.volume),
    updated: q.timestamp !== null && q.timestamp > 0 ? Math.floor(q.timestamp) : null,
    delayed,
  };
}
