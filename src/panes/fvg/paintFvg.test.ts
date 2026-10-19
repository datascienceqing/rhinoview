import { describe, expect, it, vi } from 'vitest';
import type { FvgZone } from '../../indicators/fvg';
import { BORDER_ALPHA, FILLED_ALPHA, OPEN_ALPHA, TOUCHED_ALPHA, paintFvg } from './paintFvg';
import type { FvgGeom, FvgPaintStyle } from './paintFvg';

const style: FvgPaintStyle = { upColor: 'UP', downColor: 'DOWN', mitigatedColor: 'GREY', textColor: 'TEXT', labels: false };
const geom: FvgGeom = { xOf: (i) => 10 * i, yOf: (p) => 1000 - 2 * p, halfBar: 5, formatPrice: (p) => p.toFixed(2) };

const zone = (over: Partial<FvgZone> = {}): FvgZone => ({
  id: 'bull-1',
  side: 'bull',
  startIndex: 4,
  createIndex: 5,
  endIndex: 10,
  top: 104,
  bottom: 101,
  touchIndex: null,
  fillIndex: null,
  ...over,
});

function recorder() {
  const calls: { op: string; args: unknown[]; fillStyle: unknown; strokeStyle: unknown; globalAlpha: number }[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    fillRect: vi.fn((...args: unknown[]) => calls.push({ op: 'fillRect', args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha })),
    strokeRect: vi.fn((...args: unknown[]) => calls.push({ op: 'strokeRect', args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha })),
    fillText: vi.fn((...args: unknown[]) => calls.push({ op: 'fillText', args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha })),
  };
  return { ctx, calls };
}

describe('paintFvg', () => {
  it('fills and outlines the box from the middle bar to the end bar, over whole bars', () => {
    const { ctx, calls } = recorder();
    paintFvg(ctx as never, [zone()], geom, style);
    // x: bar 4 at 40, bar 10 at 100, +- half a bar. y: 104 -> 792, 101 -> 798.
    expect(calls[0]).toMatchObject({ op: 'fillRect', args: [35, 792, 70, 6], fillStyle: 'UP', globalAlpha: OPEN_ALPHA });
    expect(calls[1]).toMatchObject({ op: 'strokeRect', args: [35, 792, 70, 6], strokeStyle: 'UP', globalAlpha: BORDER_ALPHA });
    expect(ctx.globalAlpha).toBe(1);
  });

  it('uses the down colour for a bearish gap and grey for a mitigated one', () => {
    const { ctx, calls } = recorder();
    paintFvg(ctx as never, [zone({ side: 'bear' }), zone({ touchIndex: 6 }), zone({ touchIndex: 6, fillIndex: 7 })], geom, style);
    const fills = calls.filter((c) => c.op === 'fillRect');
    expect(fills.map((c) => [c.fillStyle, c.globalAlpha])).toEqual([
      ['DOWN', OPEN_ALPHA],
      ['GREY', TOUCHED_ALPHA],
      ['GREY', FILLED_ALPHA],
    ]);
  });

  it('writes "FVG" and the gap size only with labels on', () => {
    const off = recorder();
    paintFvg(off.ctx as never, [zone()], geom, style);
    expect(off.ctx.fillText).not.toHaveBeenCalled();
    const on = recorder();
    paintFvg(on.ctx as never, [zone()], geom, { ...style, labels: true });
    expect(on.ctx.fillText).toHaveBeenCalledWith('FVG 3.00', 38, 795);
    expect(on.calls.at(-1)?.fillStyle).toBe('TEXT');
  });

  it('skips a gap with no pixel position', () => {
    const { ctx } = recorder();
    paintFvg(ctx as never, [zone()], { ...geom, yOf: () => null }, style);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});
