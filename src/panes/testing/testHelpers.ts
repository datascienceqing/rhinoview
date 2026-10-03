import type { Bar, IndicatorConfig, IndicatorKind } from '@shared/types';
import { ComputeCache } from '../computeCache';
import type { ComputedIndicator } from '../computeCache';
import { createIndicator } from '../config';
import { fakeComputeIndicator } from './fakeCompute';

/** A deterministic wavy series: enough swing for RSI to leave 50 and MACD to cross zero repeatedly. */
export function makeBars(count: number, startTime = 1_700_000_000, step = 86_400): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 5) + i * 0.1;
    return {
      time: startTime + i * step,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
      vwap: null,
      transactions: null,
    };
  });
}

export function indicator(kind: IndicatorKind, existing: IndicatorConfig[] = []): IndicatorConfig {
  return createIndicator(kind, existing);
}

/** Resolve configs against bars with the pane UI's own stand-in math. */
export function computeAll(bars: Bar[], configs: IndicatorConfig[]): ComputedIndicator[] {
  return new ComputeCache(fakeComputeIndicator).resolve(bars, configs);
}
