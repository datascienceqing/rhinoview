import { describe, expect, it, vi } from 'vitest';
import type { Bar, LiquidityParams } from '@shared/types';
import * as math from '../../indicators/liquidity';
import { LiquidityPrimitive } from './LiquidityPrimitive';
import type { LiquidityStyle } from './LiquidityPrimitive';

const style: LiquidityStyle = { upColor: 'UP', downColor: 'DOWN', levelColor: 'LEVEL', textColor: 'TEXT', visible: true };
const params: LiquidityParams = { lookback: 2, zoneMode: 'wick', sweepMode: 'both', minTouches: 0, maxAge: 20, sweepExtend: 3 };

/** A zig-zag: a high pivot every 6 bars (bar 3, 9, 15, ...), and a low pivot between them. */
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
  const phase = i % 6;
  const mid = 100 + [0, 2, 4, 6, 4, 2][phase]!;
  return { time: 1_700_000_000 + i * 60, open: mid - 0.5, high: mid + 1, low: mid - 1, close: mid + 0.5, volume: 100, vwap: null, transactions: null };
});

function attach(range: { from: number; to: number } | null) {
  const view = { range };
  const requestUpdate = vi.fn();
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => view.range, logicalToCoordinate: (l: number) => 10 * l }) };
  const series = { priceToCoordinate: (p: number) => 1000 - 2 * p };
  const prim = new LiquidityPrimitive(params, style);
  prim.attached({ chart, series, requestUpdate, horzScaleBehavior: {} } as never);
  return { prim, view, requestUpdate };
}

function draw(prim: LiquidityPrimitive) {
  const fillRect = vi.fn();
  const context = {
    fillRect,
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  };
  const renderer = prim.paneViews()[0]?.renderer();
  renderer?.draw({ useMediaCoordinateSpace: (f: (s: unknown) => void) => f({ context, mediaSize: { width: 800, height: 600 } }) } as never);
  return { renderer, fillRect };
}

describe('LiquidityPrimitive', () => {
  it('computes on all loaded bars and draws only the items in the visible range', () => {
    const { prim } = attach({ from: 40, to: 59 });
    prim.update(bars, params, style);
    const all = prim.result();
    const vis = prim.visible();
    expect(all.zones.length).toBeGreaterThan(10);
    expect(vis?.zones.length).toBeGreaterThan(0);
    expect(vis?.zones.length).toBeLessThan(all.zones.length);
    for (const z of vis?.zones ?? []) expect(z.endIndex).toBeGreaterThanOrEqual(40);
  });

  it('keeps a zone that starts before the visible range and reaches into it', () => {
    const { prim } = attach({ from: 40, to: 59 });
    prim.update(bars, { ...params, maxAge: 40 }, style);
    expect(prim.visible()?.zones.some((z) => z.pivotIndex < 40)).toBe(true);
  });

  it('memoizes on the bars and the params: a pan does not recompute', () => {
    const spy = vi.spyOn(math, 'computeLiquidity');
    const { prim, view } = attach({ from: 40, to: 59 });
    prim.update(bars, params, style);
    prim.visible();
    view.range = { from: 0, to: 19 };
    prim.visible();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params }, { ...style, levelColor: 'OTHER' }); // same params, new object
    prim.visible();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params, lookback: 3 }, style);
    prim.visible();
    expect(spy).toHaveBeenCalledTimes(2);
    prim.update([...bars], { ...params, lookback: 3 }, style);
    prim.visible();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('asks for a redraw on update', () => {
    const { prim, requestUpdate } = attach({ from: 0, to: 59 });
    prim.update(bars, params, style);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('paints when attached, visible and in range', () => {
    const { prim } = attach({ from: 0, to: 59 });
    prim.update(bars, params, style);
    const { renderer, fillRect } = draw(prim);
    expect(renderer).not.toBeNull();
    expect(fillRect).toHaveBeenCalled();
  });

  it('draws nothing when hidden, detached, with no range, or with no bars', () => {
    const hidden = attach({ from: 0, to: 59 });
    hidden.prim.update(bars, params, { ...style, visible: false });
    expect(draw(hidden.prim).renderer).toBeNull();

    const noRange = attach(null);
    noRange.prim.update(bars, params, style);
    expect(draw(noRange.prim).renderer).toBeNull();

    const empty = attach({ from: 0, to: 59 });
    empty.prim.update([], params, style);
    expect(draw(empty.prim).renderer).toBeNull();

    const gone = attach({ from: 0, to: 59 });
    gone.prim.update(bars, params, style);
    gone.prim.detached();
    expect(draw(gone.prim).renderer).toBeNull();
  });

  it('gives no autoscale info, so it never moves the price axis', () => {
    const { prim } = attach({ from: 0, to: 59 });
    expect((prim as unknown as { autoscaleInfo?: unknown }).autoscaleInfo).toBeUndefined();
  });
});
