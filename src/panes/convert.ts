import type { Bar, IndicatorPoint } from '@shared/types';
import type { HistogramData, LineData, UTCTimestamp, WhitespaceData } from 'lightweight-charts';

// IndicatorPoint.time is Unix seconds, i.e. exactly a UTCTimestamp. Type-level cast only,
// same as src/chart/convert.ts: no unit conversion anywhere.
function ts(point: IndicatorPoint): UTCTimestamp {
  return point.time as UTCTimestamp;
}

/** `null` (and anything non-finite) is a gap, never a number: plotting warmup as 0 would draw a real line at zero. */
function definedValue(point: IndicatorPoint): number | null {
  return point.value !== null && Number.isFinite(point.value) ? point.value : null;
}

/**
 * Warmup points become whitespace (`{ time }`, no value). They stay in the data so the
 * series covers the same times as the price series, and the library draws a gap.
 */
export function toLineData(points: readonly IndicatorPoint[]): (LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  return points.map((p) => {
    const value = definedValue(p);
    return value === null ? { time: ts(p) } : { time: ts(p), value };
  });
}

/** Histogram bars coloured by sign: `up` for >= 0, `down` below. */
export function toHistogramData(
  points: readonly IndicatorPoint[],
  up: string,
  down: string,
): (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  return points.map((p) => {
    const value = definedValue(p);
    return value === null ? { time: ts(p) } : { time: ts(p), value, color: value >= 0 ? up : down };
  });
}

/** The candle direction of the bar at `time`: close at or above open is up. Null when unknown. */
export function barDirection(bars: readonly Bar[] | undefined, index: number, time: number): 'up' | 'down' | null {
  // Points are one per bar in bar order (indicator convention 5), so the index is the fast path.
  const bar = bars?.[index];
  if (!bar || bar.time !== time) return null;
  return bar.close >= bar.open ? 'up' : 'down';
}

/** Volume bars coloured by their candle, like TradingView. Unknown direction takes `up`. */
export function toVolumeData(
  points: readonly IndicatorPoint[],
  bars: readonly Bar[] | undefined,
  up: string,
  down: string,
): (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  return points.map((p, i) => {
    const value = definedValue(p);
    if (value === null) return { time: ts(p) };
    return { time: ts(p), value, color: barDirection(bars, i, p.time) === 'down' ? down : up };
  });
}
