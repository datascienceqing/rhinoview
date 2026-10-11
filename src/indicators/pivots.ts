/**
 * Swing pivots, shared by the Liquidity and the Confluence indicators.
 *
 * Bar `i` is a pivot high when its high is greater than the high of each of the `left`
 * bars before it, and greater than or equal to the high of each of the `right` bars after
 * it. The asymmetric rule gives one pivot for a flat top of equal highs: the first bar.
 * A pivot low is the mirror. The caller makes sure that `left <= i <= n - 1 - right`;
 * a pivot is known only at bar `i + right`.
 */
import type { Bar } from '@shared/types';

export function isPivotHigh(bars: readonly Bar[], i: number, left: number, right: number): boolean {
  const h = (bars[i] as Bar).high;
  for (let k = 1; k <= left; k++) {
    if (!(h > (bars[i - k] as Bar).high)) return false; // strict on the left
  }
  for (let k = 1; k <= right; k++) {
    if (!(h >= (bars[i + k] as Bar).high)) return false; // not strict on the right
  }
  return true;
}

export function isPivotLow(bars: readonly Bar[], i: number, left: number, right: number): boolean {
  const l = (bars[i] as Bar).low;
  for (let k = 1; k <= left; k++) {
    if (!(l < (bars[i - k] as Bar).low)) return false;
  }
  for (let k = 1; k <= right; k++) {
    if (!(l <= (bars[i + k] as Bar).low)) return false;
  }
  return true;
}
