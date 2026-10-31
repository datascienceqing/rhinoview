import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { fibPrice, indexToTime, measureStats, timeToIndex } from './geometry';
import { INITIAL_DRAWINGS, drawingReducer } from './DrawingTools';
import { measureLabel } from './paintDrawings';

const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0, vwap: null, transactions: null });
const bars = [bar(100), bar(160), bar(220), bar(280)];

describe('anchors', () => {
  it('maps a bar index to its time and back', () => {
    expect(indexToTime(bars, 2)).toBe(220);
    expect(timeToIndex(bars, 220)).toBe(2);
  });

  it('extrapolates a point right of the last bar with the last bar spacing', () => {
    expect(indexToTime(bars, 5)).toBe(400);
    expect(timeToIndex(bars, 400)).toBe(5);
  });

  it('extrapolates a point left of the first bar', () => {
    expect(indexToTime(bars, -2)).toBe(-20);
    expect(timeToIndex(bars, -20)).toBe(-2);
  });

  it('keeps a point on its bar when older bars are prepended', () => {
    const t = indexToTime(bars, 1);
    expect(timeToIndex([bar(-20), bar(40), ...bars], t)).toBe(3);
  });
});

describe('fibPrice', () => {
  it('puts level 1 at the first point and level 0 at the second', () => {
    expect(fibPrice(100, 200, 1)).toBe(100);
    expect(fibPrice(100, 200, 0)).toBe(200);
    expect(fibPrice(100, 200, 0.5)).toBe(150);
    expect(fibPrice(100, 200, 0.618)).toBeCloseTo(138.2);
    expect(fibPrice(100, 200, 1.618)).toBeCloseTo(38.2);
  });
});

describe('measure', () => {
  const geom = { xOf: () => 0, yOf: () => 0, formatPrice: (p: number) => p.toFixed(2) };
  const style = { upColor: '', downColor: '', textColor: '', labelText: '', barsLabel: (n: number) => `${n} bars` };

  it('gives the change in percent of the first price', () => {
    const stats = measureStats({ a: { index: 10, price: 80 }, b: { index: 22, price: 100 } });
    expect(stats).toEqual({ change: 20, percent: 25, bars: 12 });
  });

  it('labels a fall with a minus sign', () => {
    const seg = { a: { index: 0, price: 200 }, b: { index: 4, price: 150 } };
    expect(measureLabel(seg, geom, style)).toEqual(['−50.00 (−25.00%)', '4 bars']);
  });

  it('has no percent when the first price is 0', () => {
    expect(measureStats({ a: { index: 0, price: 0 }, b: { index: 1, price: 5 } }).percent).toBeNull();
  });
});

describe('drawingReducer', () => {
  const p = (time: number, price: number) => ({ time, price });

  it('draws a fib with two clicks, keeps it for the symbol, and switches the tool off', () => {
    let s = drawingReducer(INITIAL_DRAWINGS, { type: 'tool', tool: 'fib' });
    s = drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(1, 10) });
    s = drawingReducer(s, { type: 'move', p: p(2, 15) });
    expect(s.draft).toEqual({ tool: 'fib', a: p(1, 10), b: p(2, 15) });
    s = drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(3, 20) });
    expect(s.tool).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.fibs['AAPL']).toEqual([{ a: p(1, 10), b: p(3, 20) }]);
    expect(drawingReducer(s, { type: 'clear', symbol: 'AAPL' }).fibs['AAPL']).toEqual([]);
  });

  it('clears a complete measure on the next click', () => {
    let s = drawingReducer(INITIAL_DRAWINGS, { type: 'tool', tool: 'measure' });
    s = drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(1, 10) });
    s = drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(2, 12) });
    expect(s.measure).toEqual({ a: p(1, 10), b: p(2, 12) });
    expect(s.fibs['AAPL']).toBeUndefined();
    expect(drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(3, 1) }).measure).toBeNull();
  });

  it('cancels a drawing in progress and switches the tool off', () => {
    let s = drawingReducer(INITIAL_DRAWINGS, { type: 'tool', tool: 'fib' });
    s = drawingReducer(s, { type: 'click', symbol: 'AAPL', p: p(1, 10) });
    s = drawingReducer(s, { type: 'cancel' });
    expect(s).toEqual(INITIAL_DRAWINGS);
  });

  it('switches a tool off on a second press', () => {
    const s = drawingReducer(INITIAL_DRAWINGS, { type: 'tool', tool: 'measure' });
    expect(drawingReducer(s, { type: 'tool', tool: 'measure' }).tool).toBeNull();
  });
});
