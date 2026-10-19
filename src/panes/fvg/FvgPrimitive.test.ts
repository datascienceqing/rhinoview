import { describe, expect, it, vi } from 'vitest';
import type { Bar, FvgParams } from '@shared/types';
import * as math from '../../indicators/fvg';
import { DEFAULT_PARAMS } from '../../indicators/types';
import { FvgPrimitive } from './FvgPrimitive';
import type { FvgStyle } from './FvgPrimitive';

const style: FvgStyle = { upColor: 'UP', downColor: 'DOWN', mitigatedColor: 'GREY', textColor: 'TEXT', visible: true };
const params: FvgParams = { ...DEFAULT_PARAMS.fvg, extend: 'fixed', boxLength: 5, maxZones: 500 };

/** 20 quiet bars, then a staircase up: each bar from 22 on makes a bullish gap. */
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
  const mid = i < 20 ? 100 : 100 + 5 * (i - 19);
  return { time: 1_700_000_000 + i * 60, open: mid - 1, high: mid + 1, low: mid - 1, close: mid + 1, volume: 100, vwap: null, transactions: null };
});

function attach(range: { from: number; to: number } | null) {
  const view = { range };
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => view.range, logicalToCoordinate: (l: number) => 10 * l }) };
  const series = { priceToCoordinate: (p: number) => 1000 - p, priceFormatter: () => ({ format: (p: number) => p.toFixed(2) }) };
  const requestUpdate = vi.fn();
  const prim = new FvgPrimitive(params, style);
  prim.attached({ chart, series, requestUpdate, horzScaleBehavior: {} } as never);
  return { prim, view, requestUpdate };
}

describe('FvgPrimitive', () => {
  it('computes on all loaded bars and keeps only the gaps in the visible range', () => {
    const { prim } = attach({ from: 40, to: 59 });
    prim.update(bars, params, style);
    const all = prim.result().zones;
    const vis = prim.visible() ?? [];
    expect(all.length).toBeGreaterThan(30);
    expect(vis.length).toBeGreaterThan(0);
    expect(vis.length).toBeLessThan(all.length);
    for (const z of vis) expect(z.endIndex).toBeGreaterThanOrEqual(40);
  });

  it('memoizes the result on the bars and the params', () => {
    const spy = vi.spyOn(math, 'computeFvg');
    const { prim } = attach({ from: 0, to: 59 });
    prim.update(bars, params, style);
    prim.result();
    prim.result();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params, maxZones: 10 }, style);
    prim.result();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('requests a redraw on update, and draws nothing when hidden or with no range', () => {
    const { prim, view, requestUpdate } = attach({ from: 0, to: 59 });
    prim.update(bars, params, style);
    expect(requestUpdate).toHaveBeenCalled();
    expect(prim.paneViews()[0]?.renderer()).not.toBeNull();
    prim.update(bars, params, { ...style, visible: false });
    expect(prim.paneViews()[0]?.renderer()).toBeNull();
    prim.update(bars, params, style);
    view.range = null;
    expect(prim.paneViews()[0]?.renderer()).toBeNull();
  });
});
