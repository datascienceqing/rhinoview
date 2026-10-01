import type { Bar } from '@shared/types';
import { findBarIndexByTime } from '../chart/convert';

export interface LegendModel {
  bar: Bar;
  /** close - previous bar's close (first bar: close - open). */
  change: number;
  /** Fractional, like the contract's changePercent. */
  changePercent: number;
}

/**
 * What the OHLCV legend shows. `hoverTime` null (crosshair off the chart), or a time
 * with no bar, falls back to the most recent bar so the legend is never blank.
 */
export function buildLegend(bars: readonly Bar[], hoverTime: number | null): LegendModel | null {
  const hovered = hoverTime === null ? -1 : findBarIndexByTime(bars, hoverTime);
  const index = hovered >= 0 ? hovered : bars.length - 1;
  const bar = bars[index];
  if (!bar) return null;
  const reference = bars[index - 1]?.close ?? bar.open;
  const change = bar.close - reference;
  return { bar, change, changePercent: reference === 0 ? 0 : change / reference };
}
