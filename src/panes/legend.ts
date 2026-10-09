import type { IndicatorKind, IndicatorPoint } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import type { ComputedIndicator } from './computeCache';
import { MACD_SIGNAL_COLOR, indicatorTitle } from './config';
import { barDirection } from './convert';
import { formatVolume } from '../ui/format';

const DASH = '—';

export interface LegendLineModel {
  key: string;
  /** Short name shown before the value; empty for single-line indicators. */
  name: string;
  color: string | null;
  value: number | null;
  text: string;
  /** For the MACD histogram the sign, for volume the candle, decides the colour class. */
  tone: 'up' | 'down' | null;
}

export interface IndicatorLegendModel {
  id: string;
  title: string;
  kind: IndicatorKind;
  placement: 'overlay' | 'separate';
  visible: boolean;
  error: string | null;
  lines: LegendLineModel[];
}

/** RSI is a bounded 0-100 oscillator; MACD is a price difference and is usually small; MAs are prices; volume is a share count. */
export function formatIndicatorValue(kind: IndicatorKind, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  if (kind === 'volume') return formatVolume(value);
  if (kind === 'macd') return Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4);
  return value.toFixed(2);
}

/** Index of `time` in ascending `points`, or -1. */
export function findPointIndex(points: readonly IndicatorPoint[], time: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = points[mid]?.time;
    if (t === undefined) return -1;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const LINE_NAMES: Record<string, string> = { macd: 'MACD', signal: 'Signal', histogram: 'Hist', volume: 'Vol', ma: 'MA' };

/**
 * What one indicator's legend shows. Same rule as the OHLCV legend: `hoverTime` null
 * (crosshair off the chart), or a time with no point, falls back to the latest bar.
 * A null value (warmup) renders as a dash, never as 0.
 */
export function buildIndicatorLegend(item: ComputedIndicator, hoverTime: number | null): IndicatorLegendModel {
  const { config, series, error, bars } = item;
  const lines: LegendLineModel[] = (series?.lines ?? []).map((line) => {
    const hovered = hoverTime === null ? -1 : findPointIndex(line.points, hoverTime);
    const index = hovered >= 0 ? hovered : line.points.length - 1;
    const value = line.points[index]?.value ?? null;
    const isHistogram = line.key === 'histogram';
    const isVolume = line.key === 'volume';
    const point = line.points[index];
    return {
      key: line.key,
      name: LINE_NAMES[line.key] ?? '',
      color: isHistogram || isVolume ? null : line.key === 'signal' ? MACD_SIGNAL_COLOR : config.color,
      value,
      text: formatIndicatorValue(config.kind, value),
      tone:
        isHistogram && value !== null ? (value >= 0 ? 'up' : 'down')
        : isVolume && value !== null && point ? barDirection(bars, index, point.time)
        : null,
    };
  });
  return {
    id: config.id,
    title: indicatorTitle(config),
    kind: config.kind,
    placement: INDICATOR_PLACEMENT[config.kind],
    visible: config.visible,
    error,
    lines,
  };
}
