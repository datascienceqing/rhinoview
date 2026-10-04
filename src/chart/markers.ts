/**
 * CHART MARKER SEAM — orchestrator-owned, frozen for Phase 5.
 *
 * A marker is a small labelled flag on the price series, for example TradingView's
 * "E" for an earnings report. The fundamentals module produces markers; the chart
 * draws them. Neither knows the other's internals.
 */
import type { Bar, UnixSeconds } from '@shared/types';

export interface ChartMarker {
  /** Stable id, so a re-render does not flicker. */
  id: string;
  /**
   * The event's DATE, as Unix seconds at 00:00 America/New_York of that date.
   * Not a bar time. The chart finds the bar that contains this date; see snapMarkers.
   */
  time: UnixSeconds;
  /** Short label drawn on the flag, for example "E". Keep it to 1–2 characters. */
  text: string;
  /** CSS colour. Defaults to the theme accent. */
  color?: string;
  /** Defaults to 'belowBar'. */
  position?: 'aboveBar' | 'belowBar';
}

export interface SnappedMarker extends ChartMarker {
  /** The time of the bar the marker is drawn on. */
  barTime: UnixSeconds;
}

const DAY = 86_400;

/**
 * Put each marker on the bar that CONTAINS its date: the last bar whose time is at or
 * before the end of the marker's day. That one rule gives the right answer for every
 * timeframe:
 *   • 1D  — the bar of that date (stamped at its midnight).
 *   • 1W  — the week's bar (stamped on its Monday).
 *   • 5m/15m/1h — the last bar of that session (the close).
 * Markers dated before the first bar or after the last bar are dropped: the first are
 * outside the loaded history, the second are upcoming events with no bar yet.
 * `bars` must be ascending, as the contract guarantees. Output is ascending by barTime.
 */
export function snapMarkers(bars: readonly Bar[], markers: readonly ChartMarker[]): SnappedMarker[] {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) return [];
  const out: SnappedMarker[] = [];
  for (const m of markers) {
    const endOfDay = m.time + DAY - 1;
    if (endOfDay < first.time || m.time > last.time) continue;
    // Binary search: last index with bars[i].time <= endOfDay.
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((bars[mid] as Bar).time <= endOfDay) lo = mid;
      else hi = mid - 1;
    }
    out.push({ ...m, barTime: (bars[lo] as Bar).time });
  }
  return out.sort((a, b) => a.barTime - b.barTime);
}
