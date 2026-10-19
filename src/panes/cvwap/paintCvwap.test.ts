import { describe, expect, it, vi } from 'vitest';
import type { CvwapResult } from '../../indicators/cvwap';
import { AVERAGE_ALPHA, BAND_FILL_ALPHA, VWAP_WIDTH, paintCvwap, percentTo } from './paintCvwap';
import type { CvwapGeom, CvwapPaintStyle } from './paintCvwap';

const style: CvwapPaintStyle = {
  vwapColor: 'VWAP',
  bandColor: 'BAND',
  averageColor: 'AVG',
  highColor: 'HIGH',
  lowColor: 'LOW',
  levelColor: 'LEVEL',
  bands: false,
  average: false,
  ohlc: false,
  ohlcLabels: false,
};
const geom: CvwapGeom = { xOf: (i) => 10 * i, yOf: (p) => 1000 - p, rightX: 500, formatPrice: (p) => p.toFixed(2) };

const result = (over: Partial<CvwapResult> = {}): CvwapResult => ({
  from: 2,
  to: 4,
  vwap: [100, 101, 102],
  upper: [100, 103, 105],
  lower: [100, 99, 99],
  average: 101,
  open: 100,
  high: 110,
  low: 90,
  close: 100,
  ...over,
});

function recorder() {
  const calls: { op: string; args: unknown[]; strokeStyle: unknown; fillStyle: unknown; globalAlpha: number; lineWidth: number; dash: number[] }[] = [];
  let dash: number[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    setLineDash: vi.fn((d: number[]) => {
      dash = d;
    }),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn((...args: unknown[]) => record('moveTo', args)),
    lineTo: vi.fn((...args: unknown[]) => record('lineTo', args)),
    stroke: vi.fn(() => record('stroke', [])),
    fill: vi.fn(() => record('fill', [])),
    fillText: vi.fn((...args: unknown[]) => record('fillText', args)),
  };
  function record(op: string, args: unknown[]) {
    calls.push({ op, args, strokeStyle: ctx.strokeStyle, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, dash });
  }
  return { ctx, calls };
}

describe('paintCvwap', () => {
  it('draws only the VWAP line, 2 px, through the bar centres with every option off', () => {
    const { ctx, calls } = recorder();
    paintCvwap(ctx as never, result(), geom, style);
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => c.args)).toEqual([
      [20, 900],
      [30, 899],
      [40, 898],
    ]);
    expect(calls.at(-1)).toMatchObject({ strokeStyle: 'VWAP', lineWidth: VWAP_WIDTH });
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('breaks the VWAP line at a null point', () => {
    const { ctx, calls } = recorder();
    paintCvwap(ctx as never, result({ vwap: [100, null, 102] }), geom, style);
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(2);
    expect(ctx.lineTo).not.toHaveBeenCalled();
  });

  it('fills and strokes the bands when they are on', () => {
    const { ctx, calls } = recorder();
    paintCvwap(ctx as never, result(), geom, { ...style, bands: true });
    expect(calls.find((c) => c.op === 'fill')).toMatchObject({ fillStyle: 'BAND', globalAlpha: BAND_FILL_ALPHA });
    expect(calls.filter((c) => c.op === 'stroke' && c.strokeStyle === 'BAND')).toHaveLength(2);
  });

  it('draws the average as a flat line across the window', () => {
    const { ctx, calls } = recorder();
    paintCvwap(ctx as never, result(), geom, { ...style, average: true });
    const avg = calls.filter((c) => c.strokeStyle === 'AVG' && c.op !== 'stroke');
    expect(avg.map((c) => c.args)).toEqual([
      [20, 899],
      [40, 899],
    ]);
    expect(avg[0]?.globalAlpha).toBe(AVERAGE_ALPHA);
  });

  it('draws the OHLC levels to the right edge, the open dotted, and labels the high and low', () => {
    const { ctx, calls } = recorder();
    paintCvwap(ctx as never, result(), geom, { ...style, ohlc: true, ohlcLabels: true });
    const ends = calls.filter((c) => c.op === 'lineTo' && c.args[0] === 500);
    expect(ends.map((c) => c.args[1])).toEqual([900, 890, 910, 900]);
    expect(ends[0]?.dash).toEqual([1, 3]);
    expect(ends[1]?.dash).toEqual([]);
    const texts = calls.filter((c) => c.op === 'fillText');
    // 25% of the window width from its left: 20 + 0.25 * 20.
    expect(texts.map((c) => [c.args[0], c.args[1], c.fillStyle])).toEqual([
      ['110.00 (10.00%)', 25, 'HIGH'],
      ['90.00 (-10.00%)', 25, 'LOW'],
    ]);
  });

  it('draws the OHLC levels without labels when the labels are off', () => {
    const { ctx } = recorder();
    paintCvwap(ctx as never, result(), geom, { ...style, ohlc: true, ohlcLabels: false });
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('computes the percent to the close like the Pine script', () => {
    expect(percentTo(110, 100)).toBeCloseTo(10);
    expect(percentTo(95, 100)).toBeCloseTo(-5);
  });
});
