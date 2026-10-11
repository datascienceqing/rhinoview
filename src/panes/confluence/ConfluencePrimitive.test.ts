import { describe, expect, it, vi } from 'vitest';
import type { Bar, ConfluenceParams } from '@shared/types';
import * as math from '../../indicators/confluence';
import { DEFAULT_PARAMS } from '../../indicators/types';
import { ConfluencePrimitive } from './ConfluencePrimitive';
import type { ConfluenceStyle } from './ConfluencePrimitive';

const style: ConfluenceStyle = { modeColor: 'MODE', sourceColor: 'SRC', textColor: 'TEXT', labelBackground: 'BG', visible: true };
const params: ConfluenceParams = { ...DEFAULT_PARAMS.confluence, swingLookback: 20, pivotLeft: 2, pivotRight: 2, volumeLength: 3, volumeMult: 1.2 };

/** A rising zig-zag with a volume spike every 7 bars, so breakouts happen. */
const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const mid = 100 + i * 0.2 + [0, 2, 4, 6, 4, 2][i % 6]!;
  return {
    time: 1_700_000_000 + i * 60,
    open: mid - 0.5,
    high: mid + 1,
    low: mid - 1,
    close: mid + 0.5,
    volume: i % 7 === 0 ? 400 : 100,
    vwap: null,
    transactions: null,
  };
});

function attach(range: { from: number; to: number } | null) {
  const view = { range };
  const requestUpdate = vi.fn();
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => view.range, logicalToCoordinate: (l: number) => 10 * l }) };
  const series = { priceToCoordinate: (p: number) => 1000 - 2 * p, priceFormatter: () => ({ format: (p: number) => p.toFixed(2) }) };
  const prim = new ConfluencePrimitive(params, style);
  prim.attached({ chart, series, requestUpdate, horzScaleBehavior: {} } as never);
  return { prim, view, requestUpdate };
}

function draw(prim: ConfluencePrimitive) {
  const fillText = vi.fn();
  const context = {
    fillRect: vi.fn(),
    fillText,
    measureText: (text: string) => ({ width: 6 * text.length }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
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
  return { renderer, fillText };
}

describe('ConfluencePrimitive', () => {
  it('computes on all loaded bars and marks only the events in the visible range', () => {
    const { prim } = attach({ from: 80, to: 119 });
    prim.update(bars, params, style);
    const all = prim.result().events;
    const marks = prim.drawing()?.marks ?? [];
    expect(all.some((e) => e.index < 80)).toBe(true);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length).toBeLessThan(all.length);
    for (const m of marks) expect(m.index).toBeGreaterThanOrEqual(80);
  });

  it('starts the level span swingLookback bars before the last bar', () => {
    const { prim } = attach({ from: 80, to: 119 });
    prim.update(bars, params, style);
    expect(prim.drawing()).toMatchObject({ startIndex: 99, close: (bars[119] as Bar).close, mode: 'turn', sources: 'both' });
    prim.update(bars.slice(0, 10), params, style);
    expect(prim.drawing()?.startIndex).toBe(0);
  });

  it('memoizes on the bars and the params: a pan does not recompute', () => {
    const spy = vi.spyOn(math, 'computeConfluence');
    const { prim, view } = attach({ from: 80, to: 119 });
    prim.update(bars, params, style);
    prim.drawing();
    view.range = { from: 60, to: 99 };
    prim.drawing();
    expect(spy).toHaveBeenCalledTimes(1);
    prim.update(bars, { ...params, mode: 'breakdown' }, style);
    prim.drawing();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('asks the chart to redraw on every update', () => {
    const { prim, requestUpdate } = attach({ from: 0, to: 10 });
    prim.update(bars, params, style);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('draws labels with the words of the current language', () => {
    const { prim } = attach({ from: 80, to: 119 });
    prim.update(bars, { ...params, mode: 'breakdown', breakdownMinConfluence: 1 }, style);
    const { fillText } = draw(prim);
    expect(fillText.mock.calls.some(([text]) => String(text).startsWith('Trigger '))).toBe(true);
  });

  it('draws nothing when hidden, detached, without a range, or without bars', () => {
    const hidden = attach({ from: 0, to: 119 });
    hidden.prim.update(bars, params, { ...style, visible: false });
    expect(draw(hidden.prim).renderer).toBeNull();

    const noRange = attach(null);
    noRange.prim.update(bars, params, style);
    expect(draw(noRange.prim).renderer).toBeNull();

    const empty = attach({ from: 0, to: 10 });
    empty.prim.update([], params, style);
    expect(draw(empty.prim).renderer).toBeNull();

    const gone = attach({ from: 0, to: 119 });
    gone.prim.update(bars, params, style);
    gone.prim.detached();
    expect(draw(gone.prim).renderer).toBeNull();
  });
});
