/**
 * Paints fair value gap boxes.
 *
 * Per gap: a filled box from the middle bar to the end bar, between top and bottom, with a
 * 1 px border. An open gap uses the up colour (bullish) or the down colour (bearish). A
 * mitigated gap is grey, like the Pine script: a filled gap a little stronger than a gap
 * that price only entered. With labels on, the box shows "FVG" and the gap size.
 *
 * An item whose position is off the scale (no pixel) is skipped.
 */
import type { FvgZone } from '../../indicators/fvg';

export const OPEN_ALPHA = 0.18;
export const TOUCHED_ALPHA = 0.1;
export const FILLED_ALPHA = 0.14;
export const BORDER_ALPHA = 0.9;
export const MITIGATED_BORDER_ALPHA = 0.5;
export const LABEL_FONT = '10px sans-serif';
const LABEL_PAD = 3;

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type FvgContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'strokeRect' | 'fillText' | 'globalAlpha' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline'
>;

export interface FvgGeom {
  /** Bar index (logical index) to pixel x of the bar centre, or null when it has no position. */
  xOf(index: number): number | null;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
  /** Half the bar spacing in px, so boxes cover whole bars. */
  halfBar: number;
  formatPrice(price: number): string;
}

export interface FvgPaintStyle {
  upColor: string;
  downColor: string;
  /** The colour of mitigated gaps. */
  mitigatedColor: string;
  /** The label text: the indicator colour. */
  textColor: string;
  labels: boolean;
}

export function paintFvg(ctx: FvgContext, zones: readonly FvgZone[], geom: FvgGeom, style: FvgPaintStyle): void {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  for (const z of zones) {
    const x0 = geom.xOf(z.startIndex);
    const x1 = geom.xOf(z.endIndex);
    const yTop = geom.yOf(z.top);
    const yBottom = geom.yOf(z.bottom);
    if (x0 === null || x1 === null || yTop === null || yBottom === null) continue;
    const x = Math.min(x0, x1) - geom.halfBar;
    const w = Math.max(1, Math.abs(x1 - x0) + 2 * geom.halfBar);
    const y = Math.min(yTop, yBottom);
    const h = Math.max(1, Math.abs(yTop - yBottom));

    const filled = z.fillIndex !== null;
    const mitigated = filled || z.touchIndex !== null;
    const color = mitigated ? style.mitigatedColor : z.side === 'bull' ? style.upColor : style.downColor;

    ctx.globalAlpha = filled ? FILLED_ALPHA : mitigated ? TOUCHED_ALPHA : OPEN_ALPHA;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);

    ctx.globalAlpha = mitigated ? MITIGATED_BORDER_ALPHA : BORDER_ALPHA;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);

    if (!style.labels) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = style.textColor;
    ctx.fillText(`FVG ${geom.formatPrice(z.top - z.bottom)}`, x + LABEL_PAD, y + LABEL_PAD);
  }
  ctx.globalAlpha = 1;
}
