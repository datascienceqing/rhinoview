import { describe, expect, it, vi } from 'vitest';
import type { ConfluenceState } from '../../indicators/confluence';
import { LABEL_HEIGHT, PRIMARY_ALPHA, SECONDARY_ALPHA, paintConfluence, spreadLabels } from './paintConfluence';
import type { ConfluenceDrawing, ConfluenceGeom } from './paintConfluence';

/** A context that records each call with the style at that moment. */
function recorder() {
  const calls: { op: string; args: unknown[]; fill: string; stroke: string; alpha: number; dash: number[]; width: number }[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    dash: [] as number[],
    setLineDash(d: number[]) {
      this.dash = d;
    },
  };
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args, fill: String(ctx.fillStyle), stroke: String(ctx.strokeStyle), alpha: ctx.globalAlpha, dash: ctx.dash, width: ctx.lineWidth });
  const context = Object.assign(ctx, {
    fillRect: vi.fn(rec('fillRect')),
    fillText: vi.fn(rec('fillText')),
    beginPath: vi.fn(),
    moveTo: vi.fn(rec('moveTo')),
    lineTo: vi.fn(rec('lineTo')),
    closePath: vi.fn(),
    fill: vi.fn(rec('fill')),
    stroke: vi.fn(rec('stroke')),
  });
  return { context, calls };
}

// x = 10 px per bar, y = 1000 - 2 * price, pane 800 px wide.
const geom: ConfluenceGeom = {
  xOf: (i) => 10 * i,
  yOf: (p) => 1000 - 2 * p,
  halfBar: 5,
  width: 800,
  formatPrice: (p) => p.toFixed(2),
};
const style = { modeColor: 'MODE', sourceColor: 'SRC', textColor: 'TEXT' };
const words = { trigger: 'Trigger', secondary: 'Secondary', invalidation: 'Invalidation', retest: 'Retest', latched: '(latched)' };

const state: ConfluenceState = {
  index: 59,
  primary: { bottom: 110, top: 112, count: 4 },
  secondary: { bottom: 120, top: 121, count: 2 },
  trigger: 112,
  latched: false,
  invalidation: { index: 40, price: 95 },
  sources: [
    { kind: 'fib', name: 'Fib 0.618', value: 111 },
    { kind: 'fib', name: 'Fib 0.236', value: 90 },
    { kind: 'ma', name: 'SMA 50', value: 105 },
  ],
  broken: null,
};
const drawing = (over: Partial<ConfluenceDrawing> = {}): ConfluenceDrawing => ({
  mode: 'turn',
  sources: 'both',
  state,
  close: 100,
  startIndex: 9,
  marks: [],
  ...over,
});
const texts = (calls: ReturnType<typeof recorder>['calls']) => calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);

describe('paintConfluence', () => {
  it('draws the primary box and a solid 2 px trigger line, from the span start to the right edge', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing(), geom, style, words);
    const box = calls.find((c) => c.op === 'fillRect' && c.alpha === PRIMARY_ALPHA);
    // Span start: bar 9 at x 90, minus half a bar. Top 112 -> y 776, bottom 110 -> y 780.
    expect(box?.args).toEqual([85, 776, 715, 4]);
    expect(box?.fill).toBe('MODE');
    const trigger = calls.find((c) => c.op === 'stroke' && c.width === 2);
    expect(trigger).toMatchObject({ stroke: 'MODE', alpha: 1, dash: [] });
  });

  it('draws the secondary lighter, with a dashed line', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing(), geom, style, words);
    expect(calls.some((c) => c.op === 'fillRect' && c.alpha === SECONDARY_ALPHA)).toBe(true);
    const lines = calls.filter((c) => c.op === 'stroke' && c.stroke === 'MODE');
    expect(lines.some((c) => c.width === 1 && c.dash.length > 0)).toBe(true);
  });

  it('labels each level with its price at the right edge', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing(), geom, style, words);
    expect(texts(calls)).toEqual(
      expect.arrayContaining(['Trigger 4× 112.00', 'Secondary 2× 121.00', 'Invalidation 95.00', 'Fib 0.618 111.00', 'SMA 50 105.00']),
    );
    for (const c of calls.filter((x) => x.op === 'fillText')) expect(c.args[1]).toBe(796);
  });

  it('adds "(latched)" to the cluster labels while the latch holds', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing({ state: { ...state, latched: true } }), geom, style, words);
    expect(texts(calls)).toContain('Trigger 4× 112.00 (latched)');
  });

  it('draws the chosen source lines: all in mode turn, only those below the close in mode breakdown', () => {
    const sourceLabels = (d: ConfluenceDrawing) => {
      const { context, calls } = recorder();
      paintConfluence(context, d, geom, style, words);
      return calls.filter((c) => c.op === 'fillText' && c.fill === 'SRC').map((c) => c.args[0]);
    };
    expect(sourceLabels(drawing())).toHaveLength(3);
    expect(sourceLabels(drawing({ sources: 'fibs' }))).toEqual(expect.arrayContaining(['Fib 0.618 111.00', 'Fib 0.236 90.00']));
    expect(sourceLabels(drawing({ sources: 'mas' }))).toEqual(['SMA 50 105.00']);
    expect(sourceLabels(drawing({ sources: 'none' }))).toEqual([]);
    expect(sourceLabels(drawing({ mode: 'breakdown' }))).toEqual(['Fib 0.236 90.00']);
  });

  it('draws the retest line from the breakdown bar', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing({ mode: 'breakdown', state: { ...state, broken: { index: 50, price: 98 } } }), geom, style, words);
    expect(texts(calls)).toContain('Retest 98.00');
    // The line starts at bar 50 (x 500), at price 98 (y 804).
    expect(calls.some((c) => c.op === 'moveTo' && c.args[0] === 500 && c.args[1] === 804)).toBe(true);
  });

  it('marks a breakout below the bar, pointing up, and a breakdown above the bar, pointing down', () => {
    const tips = (mode: 'turn' | 'breakdown') => {
      const { context, calls } = recorder();
      paintConfluence(context, drawing({ mode, marks: [{ index: 30, high: 104, low: 100 }] }), geom, style, words);
      expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1);
      return calls.find((c) => c.op === 'moveTo' && c.args[0] === 300)?.args[1];
    };
    expect(tips('turn')).toBe(804); // low 100 -> y 800, 4 px below
    expect(tips('breakdown')).toBe(788); // high 104 -> y 792, 4 px above
  });

  it('skips an item that has no pixel', () => {
    const { context, calls } = recorder();
    paintConfluence(context, drawing(), { ...geom, yOf: () => null }, style, words);
    expect(calls.filter((c) => c.op === 'fillRect' || c.op === 'fillText' || c.op === 'stroke')).toEqual([]);
  });
});

describe('spreadLabels', () => {
  it('moves a label down when it is nearer than one label height to the label above', () => {
    expect(spreadLabels([{ y: 100 }, { y: 104 }, { y: 200 }, { y: 50 }]).map((l) => l.y)).toEqual([50, 100, 100 + LABEL_HEIGHT, 200]);
  });

  it('pushes a chain of close labels down one after another', () => {
    expect(spreadLabels([{ y: 10 }, { y: 11 }, { y: 12 }]).map((l) => l.y)).toEqual([10, 10 + LABEL_HEIGHT, 10 + 2 * LABEL_HEIGHT]);
  });
});
