import { describe, expect, it } from 'vitest';
import type { VpvrProfile } from '../../indicators/vpvr';
import { VPVR_OUTSIDE_ALPHA, VPVR_POC_ALPHA, VPVR_VA_ALPHA, paintVpvr } from './paintVpvr';
import type { PaintContext } from './paintVpvr';

type Call = { op: 'fill' | 'stroke'; x: number; y: number; w: number; h: number; style: string; alpha: number };

/** Records every rectangle with the style and alpha in force when it was drawn. */
function recorder(): PaintContext & { calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ op: 'fill', x, y, w, h, style: String(ctx.fillStyle), alpha: ctx.globalAlpha });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ op: 'stroke', x, y, w, h, style: String(ctx.strokeStyle), alpha: ctx.globalAlpha });
    },
  };
  return ctx;
}

// Three rows of height 10 from price 100; row 1 is the POC and alone in the value area.
const profile: VpvrProfile = {
  rows: [
    { price: 100, up: 30, down: 10 },
    { price: 110, up: 50, down: 50 },
    { price: 120, up: 0, down: 0 },
  ],
  rowH: 10,
  min: 100,
  maxTotal: 100,
  poc: 1,
  vaFrom: 1,
  vaTo: 1,
};
// 2 px per price unit, y grows downward.
const geom = { rightX: 500, maxW: 200, yOf: (p: number) => 1000 - 2 * p };
const style = { upColor: 'U', downColor: 'D', showPoc: true, pocColor: 'T' };

describe('paintVpvr', () => {
  it('draws each row from the right edge, its width in proportion to its volume', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, geom, style);
    const fills = ctx.calls.filter((c) => c.op === 'fill');
    // Row 0: total 40 of 100 -> 80 px; up 30/40 -> 60 px on the left, down 20 px next to the axis.
    expect(fills.slice(0, 2)).toEqual([
      expect.objectContaining({ x: 420, w: 60, style: 'U' }),
      expect.objectContaining({ x: 480, w: 20, style: 'D' }),
    ]);
    // Row 1 is the largest: the full 200 px.
    expect(fills[2]?.x).toBe(300);
    expect((fills[2]?.w ?? 0) + (fills[3]?.w ?? 0)).toBe(200);
  });

  it('skips empty rows', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, geom, style);
    expect(ctx.calls.filter((c) => c.op === 'fill')).toHaveLength(4);
  });

  it('places rows at their prices, with a 1 px gap', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, geom, style);
    // Row 0 is [100, 110): top at y(110) = 780, bottom at y(100) = 800.
    expect(ctx.calls[0]).toMatchObject({ y: 780, h: 19 });
  });

  it('draws the value area brighter than the rest', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, geom, style);
    expect(ctx.calls[0]?.alpha).toBe(VPVR_OUTSIDE_ALPHA);
    expect(ctx.calls[2]?.alpha).toBe(VPVR_VA_ALPHA);
  });

  it('outlines the POC row across the full profile width, and resets alpha', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, geom, style);
    expect(ctx.calls.at(-1)).toMatchObject({ op: 'stroke', x: 300.5, w: 199, style: 'T', alpha: VPVR_POC_ALPHA });
    expect(ctx.globalAlpha).toBe(1);
    const off = recorder();
    paintVpvr(off, profile, geom, { ...style, showPoc: false });
    expect(off.calls.some((c) => c.op === 'stroke')).toBe(false);
  });

  it('skips a row whose price has no pixel position', () => {
    const ctx = recorder();
    paintVpvr(ctx, profile, { ...geom, yOf: (p) => (p >= 110 ? null : 1000 - 2 * p) }, style);
    expect(ctx.calls).toHaveLength(0);
  });
});
