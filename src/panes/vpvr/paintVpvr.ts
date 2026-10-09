/**
 * Paints a visible-range volume profile. Ported from Vela (github.com/datascienceqing/Vela,
 * Apache-2.0), `src/renderers/native/vpvr/paintVpvr.ts`. Change: a row whose price has no
 * pixel position (off the price scale) is skipped.
 */
import type { VpvrProfile } from '../../indicators/vpvr';

/** Row opacity inside and outside the value area (the profile sits over the candles). */
export const VPVR_VA_ALPHA = 0.62;
export const VPVR_OUTSIDE_ALPHA = 0.28;
/** Opacity of the point-of-control outline. */
export const VPVR_POC_ALPHA = 0.9;

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'strokeRect' | 'globalAlpha' | 'fillStyle' | 'strokeStyle' | 'lineWidth'
>;

export interface VpvrGeom {
  /** Right pixel edge of the plot area: rows start here and extend left. */
  rightX: number;
  /** Pixel width of the largest row. */
  maxW: number;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
}

export interface VpvrPaintStyle {
  upColor: string;
  downColor: string;
  showPoc: boolean;
  pocColor: string;
}

/** Pixel top and height of the row `[price, price + rowH)`, with a 1 px gap between rows. */
function rowBox(price: number, rowH: number, yOf: VpvrGeom['yOf']): { top: number; h: number } | null {
  const top = yOf(price + rowH);
  const bottom = yOf(price);
  if (top === null || bottom === null) return null;
  return { top, h: Math.max(1, bottom - top - 1) };
}

/**
 * One horizontal row per price bucket, against the right edge, its width in proportion
 * to its volume against the largest row. A row is split: the up part on the left, the
 * down part on the right, next to the axis. Rows in the value area are brighter; the POC
 * row has an outline.
 */
export function paintVpvr(ctx: PaintContext, profile: VpvrProfile, geom: VpvrGeom, style: VpvrPaintStyle): void {
  const { rows, rowH, maxTotal, poc, vaFrom, vaTo } = profile;
  const { rightX, maxW, yOf } = geom;
  if (maxTotal <= 0 || maxW <= 0) return;

  rows.forEach((row, k) => {
    const total = row.up + row.down;
    if (total <= 0) return;
    const box = rowBox(row.price, rowH, yOf);
    if (!box) return;
    const w = (total / maxTotal) * maxW;
    const upW = (row.up / total) * w;
    ctx.globalAlpha = k >= vaFrom && k <= vaTo ? VPVR_VA_ALPHA : VPVR_OUTSIDE_ALPHA;
    if (upW > 0) {
      ctx.fillStyle = style.upColor;
      ctx.fillRect(rightX - w, box.top, upW, box.h);
    }
    if (w - upW > 0) {
      ctx.fillStyle = style.downColor;
      ctx.fillRect(rightX - w + upW, box.top, w - upW, box.h);
    }
  });

  const pocRow = rows[poc];
  const box = style.showPoc && pocRow ? rowBox(pocRow.price, rowH, yOf) : null;
  if (box) {
    ctx.globalAlpha = VPVR_POC_ALPHA;
    ctx.strokeStyle = style.pocColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(rightX - maxW + 0.5, box.top + 0.5, maxW - 1, box.h);
  }
  ctx.globalAlpha = 1;
}
