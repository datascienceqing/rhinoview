/**
 * Paints the Confluence indicator (docs/CONFLUENCE_PLAN.md, section 6.1).
 *
 * The levels of the last bar run from the span start (`last - swingLookback`) to the right
 * edge of the pane: the source lines, the secondary and the primary cluster, the
 * invalidation level, and in mode "breakdown" the retest line from the latest breakdown.
 * Each has a label at the right edge; labels that would overlap move down. Each event in
 * view has a triangle: below the bar for a breakout, above it for a breakdown.
 *
 * Labels sit on a box in the pane colour, so they stay legible over the last candles.
 *
 * Colours (decision D6): the mode colour for the clusters, the retest line and the marks;
 * the indicator colour for the source lines; the text colour for the invalidation level.
 * An item whose position is off the scale (no pixel) is skipped.
 */
import type { ConfluenceMode, ConfluenceSources } from '@shared/types';
import type { ConfluenceState } from '../../indicators/confluence';

export const PRIMARY_ALPHA = 0.16;
export const SECONDARY_ALPHA = 0.08;
export const SECONDARY_LINE_ALPHA = 0.6;
export const SOURCE_ALPHA = 0.7;
export const DASH: readonly number[] = [5, 4];
export const DOT: readonly number[] = [1, 3];
export const LABEL_FONT = '10px sans-serif';
/** Vertical room one label needs; a closer label moves down. */
export const LABEL_HEIGHT = 12;
/** Gap in px between a label and the right edge, and between a mark and its bar. */
export const EDGE_GAP = 4;
/** Opacity of the box behind a label. */
export const LABEL_BOX_ALPHA = 0.8;
/** Horizontal padding in px inside the label box. */
const LABEL_PAD = 3;
/** Half the width of an event triangle, in px. */
export const MARK_SIZE = 5;

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type ConfluenceContext = Pick<
  CanvasRenderingContext2D,
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
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

export interface ConfluenceGeom {
  /** Bar index (logical index) to pixel x of the bar centre, or null when it has no position. */
  xOf(index: number): number | null;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
  /** Half the bar spacing in px. */
  halfBar: number;
  /** Width of the pane in px: the levels run to here. */
  width: number;
  /** A price as the price axis shows it. */
  formatPrice(price: number): string;
}

export interface ConfluencePaintStyle {
  modeColor: string;
  sourceColor: string;
  textColor: string;
  /** The pane background, behind the labels. */
  labelBackground: string;
}

/** The label words in the current language. */
export interface ConfluenceLabels {
  trigger: string;
  secondary: string;
  invalidation: string;
  retest: string;
  latched: string;
}

export interface ConfluenceMark {
  index: number;
  high: number;
  low: number;
}

export interface ConfluenceDrawing {
  mode: ConfluenceMode;
  sources: ConfluenceSources;
  state: ConfluenceState;
  /** The close of the last bar: mode "breakdown" draws only the source lines below it. */
  close: number;
  /** The first bar of the level span. */
  startIndex: number;
  /** The events in view. */
  marks: readonly ConfluenceMark[];
}

interface Label {
  y: number;
  text: string;
  color: string;
  alpha: number;
}

function hLine(ctx: ConfluenceContext, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

/** Labels sorted by y; each one at least LABEL_HEIGHT below the one above it. */
export function spreadLabels<T extends { y: number }>(labels: readonly T[]): T[] {
  const out = [...labels].sort((a, b) => a.y - b.y).map((l) => ({ ...l }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as T;
    const cur = out[i] as T;
    if (cur.y < prev.y + LABEL_HEIGHT) cur.y = prev.y + LABEL_HEIGHT;
  }
  return out;
}

export function paintConfluence(
  ctx: ConfluenceContext,
  drawing: ConfluenceDrawing,
  geom: ConfluenceGeom,
  style: ConfluencePaintStyle,
  words: ConfluenceLabels,
): void {
  const { state, mode } = drawing;
  const xStartBar = geom.xOf(drawing.startIndex);
  const x0 = xStartBar === null ? 0 : Math.max(0, xStartBar - geom.halfBar);
  const x1 = geom.width;
  const labels: Label[] = [];
  const price = (p: number) => geom.formatPrice(p);

  // Source lines.
  const wantFibs = drawing.sources === 'both' || drawing.sources === 'fibs';
  const wantMas = drawing.sources === 'both' || drawing.sources === 'mas';
  ctx.lineWidth = 1;
  ctx.strokeStyle = style.sourceColor;
  ctx.setLineDash([...DOT]);
  for (const s of state.sources) {
    if (s.kind === 'fib' ? !wantFibs : !wantMas) continue;
    // Mode "breakdown" draws the support side only, as the Breakdown script does.
    if (mode === 'breakdown' && !(s.value < drawing.close)) continue;
    const y = geom.yOf(s.value);
    if (y === null) continue;
    ctx.globalAlpha = SOURCE_ALPHA;
    hLine(ctx, x0, x1, y);
    labels.push({ y, text: `${s.name} ${price(s.value)}`, color: style.sourceColor, alpha: SOURCE_ALPHA });
  }

  // Clusters: the secondary under the primary.
  const clusters = [
    { c: state.secondary, primary: false },
    { c: state.primary, primary: true },
  ];
  for (const { c, primary } of clusters) {
    if (!c) continue;
    const yTop = geom.yOf(c.top);
    const yBottom = geom.yOf(c.bottom);
    if (yTop === null || yBottom === null) continue;
    ctx.globalAlpha = primary ? PRIMARY_ALPHA : SECONDARY_ALPHA;
    ctx.fillStyle = style.modeColor;
    ctx.fillRect(x0, Math.min(yTop, yBottom), x1 - x0, Math.max(1, Math.abs(yBottom - yTop)));
    ctx.globalAlpha = primary ? 1 : SECONDARY_LINE_ALPHA;
    ctx.strokeStyle = style.modeColor;
    ctx.lineWidth = primary ? 2 : 1;
    ctx.setLineDash(primary ? [] : [...DASH]);
    hLine(ctx, x0, x1, yTop);
    const name = primary ? words.trigger : words.secondary;
    const latched = state.latched ? ` ${words.latched}` : '';
    labels.push({
      y: yTop,
      text: `${name} ${c.count}× ${price(c.top)}${latched}`,
      color: style.modeColor,
      alpha: primary ? 1 : SECONDARY_LINE_ALPHA,
    });
  }

  // Invalidation, from its pivot bar.
  ctx.lineWidth = 1;
  ctx.setLineDash([...DASH]);
  if (state.invalidation) {
    const y = geom.yOf(state.invalidation.price);
    const xPivot = geom.xOf(state.invalidation.index);
    if (y !== null) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = style.textColor;
      hLine(ctx, xPivot === null ? x0 : Math.max(0, xPivot), x1, y);
      labels.push({ y, text: `${words.invalidation} ${price(state.invalidation.price)}`, color: style.textColor, alpha: 1 });
    }
  }

  // Retest line (mode "breakdown"), from the latest breakdown bar.
  if (state.broken) {
    const y = geom.yOf(state.broken.price);
    const xBreak = geom.xOf(state.broken.index);
    if (y !== null) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = style.modeColor;
      hLine(ctx, xBreak === null ? x0 : Math.max(0, xBreak), x1, y);
      labels.push({ y, text: `${words.retest} ${price(state.broken.price)}`, color: style.modeColor, alpha: 1 });
    }
  }
  ctx.setLineDash([]);

  // Event marks: a triangle pointing up below a breakout bar, down above a breakdown bar.
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.modeColor;
  for (const m of drawing.marks) {
    const x = geom.xOf(m.index);
    const yBar = geom.yOf(mode === 'turn' ? m.low : m.high);
    if (x === null || yBar === null) continue;
    const tip = mode === 'turn' ? yBar + EDGE_GAP : yBar - EDGE_GAP;
    const base = mode === 'turn' ? tip + 2 * MARK_SIZE : tip - 2 * MARK_SIZE;
    ctx.beginPath();
    ctx.moveTo(x, tip);
    ctx.lineTo(x - MARK_SIZE, base);
    ctx.lineTo(x + MARK_SIZE, base);
    ctx.closePath();
    ctx.fill();
  }

  // Labels last, so no line crosses them.
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const l of spreadLabels(labels)) {
    const w = ctx.measureText(l.text).width + 2 * LABEL_PAD;
    ctx.globalAlpha = LABEL_BOX_ALPHA;
    ctx.fillStyle = style.labelBackground;
    ctx.fillRect(x1 - EDGE_GAP - w + LABEL_PAD, l.y - LABEL_HEIGHT / 2, w, LABEL_HEIGHT);
    ctx.globalAlpha = l.alpha;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, x1 - EDGE_GAP, l.y);
  }
  ctx.globalAlpha = 1;
}
