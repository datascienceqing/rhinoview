/**
 * Paints the drawing tools: Fib retracements and the measure box.
 *
 * Fib retracement, as TradingView draws it: one horizontal line per level between the two
 * points, a light band between each pair of levels, the level and its price left of the
 * lines, and a dashed line from the first point to the second.
 *
 * Measure: a box between the two points in the up colour (the price rose) or the down
 * colour, arrows across it, and a label with the price change, the change in percent and
 * the bar count. The label sits above an up box and below a down box.
 *
 * A point that is off the scale (no pixel) skips its drawing.
 */
import { withAlpha } from '../chart/theme';
import { FIB_LEVELS, fibPrice, measureStats } from './geometry';
import type { IndexPoint, Segment } from './geometry';

/** Line colours of the levels, in the order of FIB_LEVELS (TradingView's defaults). */
export const FIB_COLORS = [
  '#787b86',
  '#f23645',
  '#ff9800',
  '#4caf50',
  '#089981',
  '#00bcd4',
  '#787b86',
  '#2962ff',
  '#f23645',
  '#9c27b0',
  '#e91e63',
] as const;
export const BAND_ALPHA = 0.08;
export const BOX_ALPHA = 0.2;
export const FONT = '11px sans-serif';
const LABEL_GAP = 4;
const LINE_HEIGHT = 15;
const LABEL_PAD = 6;
const ARROW = 5;

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'setLineDash'
  | 'globalAlpha'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>;

export interface DrawGeom {
  /** Bar index (logical index) to pixel x, or null when it has no position. */
  xOf(index: number): number | null;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
  formatPrice(price: number): string;
}

export interface DrawStyle {
  upColor: string;
  downColor: string;
  /** The dashed line of a retracement. */
  textColor: string;
  /** Text on the measure label. */
  labelText: string;
  /** "12 bars", in the current language. */
  barsLabel(bars: number): string;
}

export interface DrawScene {
  fibs: readonly Segment<IndexPoint>[];
  measure: Segment<IndexPoint> | null;
}

export function paintDrawings(ctx: DrawContext, scene: DrawScene, geom: DrawGeom, style: DrawStyle): void {
  ctx.font = FONT;
  ctx.lineWidth = 1;
  for (const fib of scene.fibs) paintFib(ctx, fib, geom, style);
  if (scene.measure) paintMeasure(ctx, scene.measure, geom, style);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

function line(ctx: DrawContext, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

export function paintFib(ctx: DrawContext, seg: Segment<IndexPoint>, geom: DrawGeom, style: DrawStyle): void {
  const xa = geom.xOf(seg.a.index);
  const xb = geom.xOf(seg.b.index);
  const ya = geom.yOf(seg.a.price);
  const yb = geom.yOf(seg.b.price);
  if (xa === null || xb === null || ya === null || yb === null) return;
  const left = Math.min(xa, xb);
  const width = Math.max(1, Math.abs(xb - xa));

  const levels = FIB_LEVELS.map((level, i) => {
    const price = fibPrice(seg.a.price, seg.b.price, level);
    return { level, price, y: geom.yOf(price), color: FIB_COLORS[i] ?? style.textColor };
  });

  // Bands first, so the lines stay on top of them. Each band takes the colour of its outer level.
  ctx.globalAlpha = BAND_ALPHA;
  for (let i = 1; i < levels.length; i++) {
    const inner = levels[i - 1];
    const outer = levels[i];
    if (!inner || !outer || inner.y === null || outer.y === null) continue;
    ctx.fillStyle = outer.color;
    ctx.fillRect(left, Math.min(inner.y, outer.y), width, Math.abs(outer.y - inner.y));
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const l of levels) {
    if (l.y === null) continue;
    ctx.strokeStyle = l.color;
    line(ctx, left, l.y, left + width, l.y);
    ctx.fillStyle = l.color;
    ctx.fillText(`${l.level} (${geom.formatPrice(l.price)})`, left - LABEL_GAP, l.y);
  }

  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = style.textColor;
  ctx.setLineDash([4, 4]);
  line(ctx, xa, ya, xb, yb);
  ctx.setLineDash([]);
}

export function measureLabel(seg: Segment<IndexPoint>, geom: DrawGeom, style: DrawStyle): [string, string] {
  const stats = measureStats(seg);
  // A real minus sign, as TradingView shows it, not a hyphen.
  const sign = stats.change < 0 ? '−' : '+';
  const percent = stats.percent === null ? '' : ` (${sign}${Math.abs(stats.percent).toFixed(2)}%)`;
  return [`${sign}${geom.formatPrice(Math.abs(stats.change))}${percent}`, style.barsLabel(stats.bars)];
}

export function paintMeasure(ctx: DrawContext, seg: Segment<IndexPoint>, geom: DrawGeom, style: DrawStyle): void {
  const xa = geom.xOf(seg.a.index);
  const xb = geom.xOf(seg.b.index);
  const ya = geom.yOf(seg.a.price);
  const yb = geom.yOf(seg.b.price);
  if (xa === null || xb === null || ya === null || yb === null) return;
  const up = seg.b.price >= seg.a.price;
  const color = up ? style.upColor : style.downColor;
  const top = Math.min(ya, yb);
  const bottom = Math.max(ya, yb);
  const midX = (xa + xb) / 2;
  const midY = (ya + yb) / 2;

  ctx.globalAlpha = 1;
  ctx.fillStyle = withAlpha(color, BOX_ALPHA);
  ctx.fillRect(Math.min(xa, xb), top, Math.max(1, Math.abs(xb - xa)), Math.max(1, bottom - top));

  // Arrows from the first point towards the second, on both axes.
  ctx.strokeStyle = color;
  ctx.setLineDash([]);
  line(ctx, midX, ya, midX, yb);
  const dy = yb >= ya ? -ARROW : ARROW;
  line(ctx, midX - ARROW, yb + dy, midX, yb);
  line(ctx, midX + ARROW, yb + dy, midX, yb);
  line(ctx, xa, midY, xb, midY);
  const dx = xb >= xa ? -ARROW : ARROW;
  line(ctx, xb + dx, midY - ARROW, xb, midY);
  line(ctx, xb + dx, midY + ARROW, xb, midY);

  const text = measureLabel(seg, geom, style);
  const textWidth = Math.max(...text.map((s) => ctx.measureText(s).width));
  const boxW = textWidth + 2 * LABEL_PAD;
  const boxH = text.length * LINE_HEIGHT + LABEL_PAD;
  const boxY = up ? top - LABEL_GAP - boxH : bottom + LABEL_GAP;
  ctx.fillStyle = color;
  ctx.fillRect(midX - boxW / 2, boxY, boxW, boxH);
  ctx.fillStyle = style.labelText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  text.forEach((s, i) => ctx.fillText(s, midX, boxY + LABEL_PAD / 2 + 1 + i * LINE_HEIGHT));
}
