/**
 * Paints the Chart VWAP, like the Pine script "Chart VWAP".
 *
 * - The VWAP line, 2 px, through the bar centres of the window.
 * - With a band multiplier above 0: the upper and lower bands, 1 px, and a light fill
 *   between them.
 * - With the average on: a 1 px line at the mean close across the window.
 * - With OHLC on: lines at the window's open (dotted), high, low and close, from the first
 *   bar to the right edge of the pane. With labels on, the high and low lines show the
 *   price and the distance to the close in percent, at 25% of the window width.
 *
 * A point whose position is off the scale (no pixel) breaks the line there.
 */
import type { CvwapResult } from '../../indicators/cvwap';

export const VWAP_WIDTH = 2;
export const BAND_FILL_ALPHA = 0.05;
export const AVERAGE_ALPHA = 0.5;
/** The Pine script draws the high, low and close levels at about half opacity. */
export const LEVEL_ALPHA = 0.5;
export const LABEL_FONT = '11px sans-serif';
/** Where the high and low labels sit: this share of the window width from its left. */
export const LABEL_POS = 0.25;
const LABEL_GAP = 3;
const DOT_DASH = [1, 3];

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type CvwapContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'stroke'
  | 'fill'
  | 'fillText'
  | 'setLineDash'
  | 'globalAlpha'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>;

export interface CvwapGeom {
  /** Bar index (logical index) to pixel x of the bar centre, or null when it has no position. */
  xOf(index: number): number | null;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
  /** The right edge of the pane in px. */
  rightX: number;
  formatPrice(price: number): string;
}

export interface CvwapPaintStyle {
  vwapColor: string;
  bandColor: string;
  averageColor: string;
  highColor: string;
  lowColor: string;
  /** The open and close levels. */
  levelColor: string;
  bands: boolean;
  average: boolean;
  ohlc: boolean;
  ohlcLabels: boolean;
}

/** Percent from `to` to `from`, like the Pine script's `percent()`. */
export function percentTo(from: number, to: number): number {
  return ((from - to) / to) * 100;
}

/** Pixel points of a series, split into runs where a point has no position. */
function runs(values: readonly (number | null)[], from: number, geom: CvwapGeom): [number, number][][] {
  const out: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, k) => {
    const x = geom.xOf(from + k);
    const y = v === null ? null : geom.yOf(v);
    if (x === null || y === null) {
      if (run.length > 0) out.push(run);
      run = [];
      return;
    }
    run.push([x, y]);
  });
  if (run.length > 0) out.push(run);
  return out;
}

function strokeRuns(ctx: CvwapContext, lines: [number, number][][]): void {
  for (const run of lines) {
    ctx.beginPath();
    run.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
}

function hLine(ctx: CvwapContext, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

/** The band fill: one polygon per stretch where both bands have a position. */
function fillBands(ctx: CvwapContext, r: CvwapResult, geom: CvwapGeom): void {
  let poly: { x: number; yU: number; yL: number }[] = [];
  const flush = () => {
    if (poly.length > 1) {
      ctx.beginPath();
      poly.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.yU) : ctx.lineTo(p.x, p.yU)));
      for (let k = poly.length - 1; k >= 0; k -= 1) {
        const p = poly[k] as { x: number; yL: number };
        ctx.lineTo(p.x, p.yL);
      }
      ctx.closePath();
      ctx.fill();
    }
    poly = [];
  };
  r.upper.forEach((u, k) => {
    const l = r.lower[k] ?? null;
    const x = geom.xOf(r.from + k);
    const yU = u === null ? null : geom.yOf(u);
    const yL = l === null ? null : geom.yOf(l);
    if (x === null || yU === null || yL === null) {
      flush();
      return;
    }
    poly.push({ x, yU, yL });
  });
  flush();
}

export function paintCvwap(ctx: CvwapContext, r: CvwapResult, geom: CvwapGeom, style: CvwapPaintStyle): void {
  ctx.setLineDash([]);
  const xFrom = geom.xOf(r.from);
  const xTo = geom.xOf(r.to);

  if (style.bands) {
    ctx.globalAlpha = BAND_FILL_ALPHA;
    ctx.fillStyle = style.bandColor;
    fillBands(ctx, r, geom);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.bandColor;
    ctx.lineWidth = 1;
    strokeRuns(ctx, runs(r.upper, r.from, geom));
    strokeRuns(ctx, runs(r.lower, r.from, geom));
  }

  if (style.average && xFrom !== null && xTo !== null) {
    const y = geom.yOf(r.average);
    if (y !== null) {
      ctx.globalAlpha = AVERAGE_ALPHA;
      ctx.strokeStyle = style.averageColor;
      ctx.lineWidth = 1;
      hLine(ctx, xFrom, xTo, y);
    }
  }

  if (style.ohlc && xFrom !== null) {
    ctx.lineWidth = 1;
    const levels = [
      { price: r.open, color: style.levelColor, alpha: 1, dotted: true },
      { price: r.high, color: style.highColor, alpha: LEVEL_ALPHA, dotted: false },
      { price: r.low, color: style.lowColor, alpha: LEVEL_ALPHA, dotted: false },
      { price: r.close, color: style.levelColor, alpha: LEVEL_ALPHA, dotted: false },
    ];
    for (const level of levels) {
      const y = geom.yOf(level.price);
      if (y === null) continue;
      ctx.globalAlpha = level.alpha;
      ctx.strokeStyle = level.color;
      ctx.setLineDash(level.dotted ? DOT_DASH : []);
      hLine(ctx, xFrom, geom.rightX, y);
    }
    ctx.setLineDash([]);

    if (style.ohlcLabels && xTo !== null) {
      const x = xFrom + (xTo - xFrom) * LABEL_POS;
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'center';
      const labels = [
        { price: r.high, color: style.highColor, baseline: 'bottom' as const, dy: -LABEL_GAP },
        { price: r.low, color: style.lowColor, baseline: 'top' as const, dy: LABEL_GAP },
      ];
      for (const label of labels) {
        const y = geom.yOf(label.price);
        if (y === null) continue;
        ctx.globalAlpha = 1;
        ctx.fillStyle = label.color;
        ctx.textBaseline = label.baseline;
        ctx.fillText(`${geom.formatPrice(label.price)} (${percentTo(label.price, r.close).toFixed(2)}%)`, x, y + label.dy);
      }
    }
  }

  // The VWAP last, so it sits over its bands and the levels.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = style.vwapColor;
  ctx.lineWidth = VWAP_WIDTH;
  strokeRuns(ctx, runs(r.vwap, r.from, geom));
}
