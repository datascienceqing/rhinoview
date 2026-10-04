/**
 * Pure conversions from FMP rows to contract types. No I/O, no clock.
 */
import type { Bar, Snapshot, UnixSeconds } from '@shared/types';
import { dayStartUnix, mondayOf, nyDayOf } from '../calendar';
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
      volume: r.volume,
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
 * FMP has no VWAP or trade count on these rows: null, never 0.
 */
export function intradayRowsToBars(rows: readonly IntradayRow[]): Bar[] {
  const byTime = new Map<UnixSeconds, Bar>();
  for (const r of rows) {
    const time = dateTimeToNySeconds(r.date);
    if (time === undefined) continue;
    byTime.set(time, { time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, vwap: null, transactions: null });
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
    dayVolume: q.volume,
    updated: q.timestamp !== null && q.timestamp > 0 ? Math.floor(q.timestamp) : null,
    delayed,
  };
}
