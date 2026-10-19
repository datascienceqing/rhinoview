import { describe, expect, it, vi } from 'vitest';
import type { Bar, CvwapParams } from '@shared/types';
import * as math from '../../indicators/cvwap';
import { DEFAULT_PARAMS } from '../../indicators/types';
import { CvwapPrimitive } from './CvwapPrimitive';
import type { CvwapStyle } from './CvwapPrimitive';

const style: CvwapStyle = {
  vwapColor: 'VWAP',
  bandColor: 'BAND',
  averageColor: 'AVG',
  highColor: 'HIGH',
  lowColor: 'LOW',
  levelColor: 'LEVEL',
  visible: true,
};
const params: CvwapParams = { ...DEFAULT_PARAMS.cvwap };

const bars: Bar[] = Array.from({ length: 50 }, (_, i) => ({
  time: 1_700_000_000 + i * 60,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100 + i,
  volume: 100,
  vwap: null,
  transactions: null,
}));

function attach(range: { from: number; to: number } | null) {
  const view = { range };
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => view.range, logicalToCoordinate: (l: number) => 10 * l }) };
  const series = { priceToCoordinate: (p: number) => 1000 - p, priceFormatter: () => ({ format: (p: number) => p.toFixed(2) }) };
  const requestUpdate = vi.fn();
  const prim = new CvwapPrimitive(params, style);
  prim.attached({ chart, series, requestUpdate, horzScaleBehavior: {} } as never);
  return { prim, view, requestUpdate };
}

describe('CvwapPrimitive', () => {
  it('anchors on the leftmost visible bar and moves the anchor with the view', () => {
    const { prim, view } = attach({ from: 10.4, to: 19.6 });
    prim.update(bars, params, style);
    expect(prim.result()).toMatchObject({ from: 10, to: 20, open: 110 });
    expect(prim.result()?.vwap[0]).toBeCloseTo(110);
    view.range = { from: 30, to: 60 };
    expect(prim.result()).toMatchObject({ from: 30, to: 49 });
    expect(prim.result()?.vwap[0]).toBeCloseTo(130);
  });

  it('memoizes the result on the window, the bars and the band multiplier', () => {
    const spy = vi.spyOn(math, 'computeCvwap');
    const { prim } = attach({ from: 0, to: 49 });
    prim.update(bars, params, style);
    prim.result();
    prim.result();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params, average: 'off' }, style);
    prim.result();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params, bandMult: 2 }, style);
    prim.result();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('requests a redraw on update, and draws nothing when hidden, with no range or with no bars', () => {
    const { prim, view, requestUpdate } = attach({ from: 0, to: 49 });
    prim.update(bars, params, style);
    expect(requestUpdate).toHaveBeenCalled();
    expect(prim.paneViews()[0]?.renderer()).not.toBeNull();
    prim.update(bars, params, { ...style, visible: false });
    expect(prim.paneViews()[0]?.renderer()).toBeNull();
    prim.update([], params, style);
    expect(prim.paneViews()[0]?.renderer()).toBeNull();
    prim.update(bars, params, style);
    view.range = null;
    expect(prim.paneViews()[0]?.renderer()).toBeNull();
  });
});
