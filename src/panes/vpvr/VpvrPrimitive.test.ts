import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '@shared/types';
import { VpvrPrimitive } from './VpvrPrimitive';
import type { VpvrStyle } from './VpvrPrimitive';

const style: VpvrStyle = {
  rows: 10,
  widthFrac: 0.3,
  valueAreaFrac: 0.7,
  upColor: '#00f',
  downColor: '#f00',
  pocColor: '#fff',
  visible: true,
};

/** Bar i spans [100 + i, 110 + i] with volume 100, so later bars sit higher. */
const bars: Bar[] = Array.from({ length: 50 }, (_, i) => ({
  time: 1_700_000_000 + i * 60,
  open: 100 + i,
  high: 110 + i,
  low: 100 + i,
  close: 110 + i,
  volume: 100,
  vwap: null,
  transactions: null,
}));

function attach(range: { from: number; to: number } | null) {
  const view = { range };
  const requestUpdate = vi.fn();
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => view.range }) };
  const series = { priceToCoordinate: (p: number) => 1000 - 2 * p };
  const prim = new VpvrPrimitive(style);
  prim.attached({ chart, series, requestUpdate, horzScaleBehavior: {} } as never);
  return { prim, view, requestUpdate };
}

function draw(prim: VpvrPrimitive) {
  const fillRect = vi.fn();
  const context = { fillRect, strokeRect: vi.fn(), globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const renderer = prim.paneViews()[0]?.renderer();
  renderer?.draw({ useMediaCoordinateSpace: (f: (s: unknown) => void) => f({ context, mediaSize: { width: 800, height: 600 } }) } as never);
  return { renderer, fillRect };
}

describe('VpvrPrimitive', () => {
  it('profiles only the visible bars', () => {
    const { prim } = attach({ from: 40, to: 49 });
    prim.update(bars, style);
    // Visible bars 40..49 span 140..159.
    expect(prim.profile()?.min).toBe(140);
    expect(prim.profile()?.rows).toHaveLength(10);
  });

  it('follows a pan: a new visible range gives a new profile', () => {
    const { prim, view } = attach({ from: 40, to: 49 });
    prim.update(bars, style);
    const first = prim.profile();
    view.range = { from: 0, to: 9 };
    expect(prim.profile()?.min).toBe(100);
    expect(prim.profile()).not.toBe(first);
  });

  it('reuses the profile while the window is the same', () => {
    const { prim } = attach({ from: 40.3, to: 48.7 });
    prim.update(bars, style);
    expect(prim.profile()).toBe(prim.profile());
  });

  it('asks the chart to redraw on update', () => {
    const { prim, requestUpdate } = attach({ from: 0, to: 9 });
    prim.update(bars, style);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('paints against the right edge of the pane, the largest row at the width fraction', () => {
    const { prim } = attach({ from: 0, to: 49 });
    prim.update(bars, style);
    const { fillRect } = draw(prim);
    expect(fillRect).toHaveBeenCalled();
    const rightEdges = fillRect.mock.calls.map(([x, , w]) => (x as number) + (w as number));
    for (const r of rightEdges) expect(r).toBeCloseTo(800, 9);
    const widest = Math.max(...fillRect.mock.calls.map(([, , w]) => w as number));
    expect(widest).toBeCloseTo(800 * 0.3, 9);
  });

  it('draws nothing when hidden, detached, or with no bars', () => {
    const hidden = attach({ from: 0, to: 9 }).prim;
    hidden.update(bars, { ...style, visible: false });
    expect(hidden.paneViews()[0]?.renderer()).toBeNull();

    const empty = attach({ from: 0, to: 9 }).prim;
    empty.update([], style);
    expect(empty.paneViews()[0]?.renderer()).toBeNull();

    const gone = attach({ from: 0, to: 9 }).prim;
    gone.update(bars, style);
    gone.detached();
    expect(gone.paneViews()[0]?.renderer()).toBeNull();
  });

  it('gives no autoscale info, so the price axis never fits the profile', () => {
    expect((new VpvrPrimitive(style) as { autoscaleInfo?: unknown }).autoscaleInfo).toBeUndefined();
  });
});
