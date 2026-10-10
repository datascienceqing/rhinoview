import { describe, expect, it } from 'vitest';
import type { LiquiditySweep, LiquidityZone } from '../../indicators/liquidity';
import { LEVEL_DASH, SWEEP_ALPHA, SWEEP_MARK_WIDTH, ZONE_ALPHA, paintLiquidity } from './paintLiquidity';
import type { LiquidityContext, LiquidityGeom, LiquidityPaintStyle } from './paintLiquidity';

type Rect = { x: number; y: number; w: number; h: number; style: string; alpha: number };
type Line = { x0: number; y0: number; x1: number; y1: number; style: string; dash: number[] };
type Text = { text: string; x: number; y: number; style: string; baseline: string };

/** Records rectangles, lines and texts with the state in force when each was drawn. */
function recorder() {
  const rects: Rect[] = [];
  const lines: Line[] = [];
  const texts: Text[] = [];
  let dash: number[] = [];
  let path: { x: number; y: number }[] = [];
  const ctx = {
    rects,
    lines,
    texts,
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(ctx.fillStyle), alpha: ctx.globalAlpha });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, style: String(ctx.fillStyle), baseline: ctx.textBaseline });
    },
    setLineDash(d: number[]) {
      dash = [...d];
    },
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ x, y });
    },
    stroke() {
      const [a, b] = path;
      if (a && b) lines.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, style: String(ctx.strokeStyle), dash });
    },
  };
  return ctx as typeof ctx & LiquidityContext;
}

// x = 10 * index, bar spacing 10, so halfBar 5. y = 1000 - 2 * price.
const geom: LiquidityGeom = { xOf: (i) => 10 * i, yOf: (p) => 1000 - 2 * p, halfBar: 5 };
const style: LiquidityPaintStyle = { upColor: 'UP', downColor: 'DOWN', levelColor: 'LEVEL', textColor: 'TEXT' };

const zone = (over: Partial<LiquidityZone> = {}): LiquidityZone => ({
  id: 'high-1',
  side: 'high',
  pivotIndex: 2,
  pivotTime: 1,
  confirmIndex: 4,
  top: 110,
  bottom: 104,
  level: 110,
  status: 'active',
  endIndex: 8,
  touches: 3,
  volume: 1_200_000,
  ...over,
});

const sweep = (over: Partial<LiquiditySweep> = {}): LiquiditySweep => ({
  id: 'high-1-wick',
  zoneId: 'high-1',
  side: 'high',
  kind: 'wick',
  direction: 'bearish',
  index: 5,
  time: 1,
  level: 110,
  extreme: 112,
  endIndex: 7,
  open: false,
  touches: 3,
  volume: 2_500_000,
  ...over,
});

describe('paintLiquidity zones', () => {
  it('draws a box from the pivot bar to the end bar, between top and bottom', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone()], [], geom, style);
    // x from 20 - 5 to 80 + 5; y from price 110 (780) to 104 (792).
    expect(ctx.rects[0]).toEqual({ x: 15, y: 780, w: 70, h: 12, style: 'DOWN', alpha: ZONE_ALPHA });
  });

  it('a low zone uses the up colour; a high zone the down colour', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone({ side: 'low', top: 93, bottom: 90, level: 90 }), zone()], [], geom, style);
    expect(ctx.rects.map((r) => r.style)).toEqual(['UP', 'DOWN']);
  });

  it('draws the level line in the indicator colour: solid while active or expired, dashed after a break', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone(), zone({ status: 'expired' }), zone({ status: 'broken' })], [], geom, style);
    expect(ctx.lines.map((l) => [l.style, l.dash, l.y0, l.y1])).toEqual([
      ['LEVEL', [], 780, 780],
      ['LEVEL', [], 780, 780],
      ['LEVEL', [...LEVEL_DASH], 780, 780],
    ]);
  });

  it('labels the zone volume at the pivot, above a high zone and below a low zone', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone(), zone({ side: 'low', top: 93, bottom: 90, level: 90, volume: 950 })], [], geom, style);
    expect(ctx.texts).toEqual([
      expect.objectContaining({ text: '1.2M', x: 15, baseline: 'bottom', style: 'TEXT' }),
      expect.objectContaining({ text: '950', x: 15, baseline: 'top' }),
    ]);
    expect((ctx.texts[0] as Text).y).toBeLessThan(780);
    expect((ctx.texts[1] as Text).y).toBeGreaterThan(1000 - 2 * 90);
  });

  it('gives a zone with no touches its box and level line, but no "0" label', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone({ touches: 0, volume: 0 }), zone({ id: 'high-2' })], [], geom, style);
    expect(ctx.rects).toHaveLength(2);
    expect(ctx.lines).toHaveLength(2);
    expect(ctx.texts.map((t) => t.text)).toEqual(['1.2M']);
  });

  it('skips a zone that has no pixel position', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone()], [], { ...geom, yOf: () => null }, style);
    expect(ctx.rects).toEqual([]);
    expect(ctx.texts).toEqual([]);
  });
});

describe('paintLiquidity sweeps', () => {
  it('draws the area from the level to the wick extreme, from the sweep bar to its end', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [], [sweep()], geom, style);
    // x 50 - 5 .. 70 + 5; y from 112 (776) to 110 (780).
    expect(ctx.rects[0]).toEqual({ x: 45, y: 776, w: 30, h: 4, style: 'DOWN', alpha: SWEEP_ALPHA });
  });

  it('marks the sweep bar with a short thick bar, and a bullish sweep uses the up colour', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [], [sweep({ direction: 'bullish', extreme: 108 })], geom, style);
    const mark = ctx.rects[1];
    expect(mark).toEqual({ x: 50 - SWEEP_MARK_WIDTH / 2, y: 780, w: SWEEP_MARK_WIDTH, h: 4, style: 'UP', alpha: 1 });
  });

  it('labels the volume the sweep took, beyond the wick', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [], [sweep()], geom, style);
    expect(ctx.texts).toEqual([expect.objectContaining({ text: '2.5M', baseline: 'bottom', style: 'DOWN' })]);
    expect((ctx.texts[0] as Text).y).toBeLessThan(776);
  });

  it('gives a sweep of a zone with no touches its area and mark, but no "0" label', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [], [sweep({ touches: 0, volume: 0 })], geom, style);
    expect(ctx.rects).toHaveLength(2);
    expect(ctx.texts).toEqual([]);
  });

  it('leaves the context with no dash and full alpha, also when the last item has no label', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone({ status: 'broken', touches: 0 })], [sweep({ touches: 0 })], geom, style);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('leaves the context with no dash and full alpha', () => {
    const ctx = recorder();
    paintLiquidity(ctx, [zone({ status: 'broken' })], [sweep()], geom, style);
    expect(ctx.globalAlpha).toBe(1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(1, 1);
    ctx.stroke();
    expect(ctx.lines.at(-1)?.dash).toEqual([]);
  });
});
