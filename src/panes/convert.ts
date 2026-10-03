import type { IndicatorPoint } from '@shared/types';
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
