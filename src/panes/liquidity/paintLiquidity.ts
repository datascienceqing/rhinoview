/**
 * Paints liquidity zones and sweeps (docs/LIQUIDITY_PLAN.md, section 6, "Drawing").
 *
 * Per zone: a box from the pivot bar to the end bar, between top and bottom; a level line
 * at the level, solid unless the zone broke, then dashed; a volume label at the pivot.
 * Per sweep: the area box, a short thick mark on the sweep bar, and the volume it took.
 * A zone with no touches has no label, and neither has a sweep of it: a "0" tells
 * nothing and covers the labels of other zones at the same price.
 *
 * Colours: a high zone and a bearish sweep use the down colour; a low zone and a bullish
 * sweep use the up colour. The indicator colour sets the level lines (decision D4).
 * An item whose position is off the scale (no pixel) is skipped.
 */
import type { LiquiditySweep, LiquidityZone } from '../../indicators/liquidity';
import { formatVolume } from '../../ui/format';

export const ZONE_ALPHA = 0.14;
export const SWEEP_ALPHA = 0.28;
export const LABEL_ALPHA = 0.9;
/** Width in px of the mark on a sweep bar. */
export const SWEEP_MARK_WIDTH = 3;
export const LEVEL_DASH: readonly number[] = [4, 3];
export const LABEL_FONT = '10px sans-serif';
const LABEL_GAP = 3;

/** The slice of CanvasRenderingContext2D the painter uses, so tests can record calls. */
export type LiquidityContext = Pick<
  CanvasRenderingContext2D,
  | 'fillRect'
  | 'fillText'
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

export interface LiquidityGeom {
  /** Bar index (logical index) to pixel x of the bar centre, or null when it has no position. */
  xOf(index: number): number | null;
  /** Price to pixel y, or null when the price has no position. */
  yOf(price: number): number | null;
  /** Half the bar spacing in px, so boxes cover whole bars. */
  halfBar: number;
}

export interface LiquidityPaintStyle {
  upColor: string;
  downColor: string;
  levelColor: string;
  textColor: string;
}

function span(geom: LiquidityGeom, from: number, to: number): { x: number; w: number } | null {
  const x0 = geom.xOf(from);
  const x1 = geom.xOf(to);
  if (x0 === null || x1 === null) return null;
  const left = Math.min(x0, x1) - geom.halfBar;
  return { x: left, w: Math.max(1, Math.abs(x1 - x0) + 2 * geom.halfBar) };
}

function band(geom: LiquidityGeom, a: number, b: number): { y: number; h: number } | null {
  const ya = geom.yOf(a);
  const yb = geom.yOf(b);
  if (ya === null || yb === null) return null;
  return { y: Math.min(ya, yb), h: Math.max(1, Math.abs(ya - yb)) };
}

export function paintLiquidity(
  ctx: LiquidityContext,
  zones: readonly LiquidityZone[],
  sweeps: readonly LiquiditySweep[],
  geom: LiquidityGeom,
  style: LiquidityPaintStyle,
): void {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';

  for (const z of zones) {
    const h = span(geom, z.pivotIndex, z.endIndex);
    const v = band(geom, z.top, z.bottom);
    const yLevel = geom.yOf(z.level);
    if (!h || !v || yLevel === null) continue;
    const color = z.side === 'high' ? style.downColor : style.upColor;

    ctx.globalAlpha = ZONE_ALPHA;
    ctx.fillStyle = color;
    ctx.fillRect(h.x, v.y, h.w, v.h);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.levelColor;
    ctx.lineWidth = 1;
    ctx.setLineDash(z.status === 'broken' ? [...LEVEL_DASH] : []);
    ctx.beginPath();
    ctx.moveTo(h.x, yLevel);
    ctx.lineTo(h.x + h.w, yLevel);
    ctx.stroke();

    if (z.touches === 0) continue;
    ctx.globalAlpha = LABEL_ALPHA;
    ctx.fillStyle = style.textColor;
    ctx.textBaseline = z.side === 'high' ? 'bottom' : 'top';
    ctx.fillText(formatVolume(z.volume), h.x, z.side === 'high' ? yLevel - LABEL_GAP : yLevel + LABEL_GAP);
  }
  ctx.setLineDash([]);

  for (const s of sweeps) {
    const h = span(geom, s.index, s.endIndex);
    const v = band(geom, s.level, s.extreme);
    const xMark = geom.xOf(s.index);
    if (!h || !v || xMark === null) continue;
    const color = s.direction === 'bearish' ? style.downColor : style.upColor;

    ctx.globalAlpha = SWEEP_ALPHA;
    ctx.fillStyle = color;
    ctx.fillRect(h.x, v.y, h.w, v.h);

    ctx.globalAlpha = 1;
    ctx.fillRect(xMark - SWEEP_MARK_WIDTH / 2, v.y, SWEEP_MARK_WIDTH, v.h);

    if (s.touches === 0) continue;
    ctx.globalAlpha = LABEL_ALPHA;
    ctx.fillStyle = color;
    // Beyond the wick extreme: above a bearish sweep, below a bullish one.
    const bearish = s.direction === 'bearish';
    ctx.textBaseline = bearish ? 'bottom' : 'top';
    ctx.fillText(formatVolume(s.volume), xMark + SWEEP_MARK_WIDTH, bearish ? v.y - LABEL_GAP : v.y + v.h + LABEL_GAP);
  }
  ctx.globalAlpha = 1;
}
