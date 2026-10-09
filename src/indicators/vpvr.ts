/**
 * Visible-range volume profile (VPVR): the volume of a window of bars, bucketed by price.
 *
 * Ported from Vela (github.com/datascienceqing/Vela, Apache-2.0),
 * `src/renderers/native/vpvr/profile.ts`. Changes: it takes this app's `Bar` (volume is
 * always a number here) and treats a non-finite volume like a missing one.
 *
 * Pure: no DOM, clock or randomness. The chart layer calls it on each redraw with the
 * visible window, and memoizes the result on that window (src/panes/VpvrPrimitive.ts).
 */
import type { Bar } from '@shared/types';

/** One profile row: `[price, price + rowH)` with the up and down volume that landed in it. */
export interface VpvrRow {
  /** The row's LOWER price bound. */
  price: number;
  up: number;
  down: number;
}

export interface VpvrProfile {
  /** Ascending by price; length is the requested row count (a flat window gives 1). */
  rows: VpvrRow[];
  /** Price height of one row. */
  rowH: number;
  /** Price floor of the profile (rows[0].price). */
  min: number;
  /** Largest single-row total volume (for normalisation; always > 0). */
  maxTotal: number;
  /** Index of the point of control: the row with the most volume. */
  poc: number;
  /** Value-area row span, inclusive `[vaFrom, vaTo]`. */
  vaFrom: number;
  vaTo: number;
}

const hasVolume = (b: Bar): boolean => Number.isFinite(b.volume) && b.volume > 0;

function clampIndex(k: number, n: number): number {
  return k < 0 ? 0 : k >= n ? n - 1 : k;
}

/**
 * Bucket the volume of `bars[i0..i1]` (inclusive, clamped to the array) by price. Each
 * bar's volume is spread over the rows its high-low range overlaps, in proportion to the
 * overlap, and goes to `up` or `down` by the bar's direction (close >= open is up), so
 * the total volume is conserved exactly. The value area grows from the POC by taking the
 * larger neighbouring row until it covers `valueAreaFrac` of the total.
 *
 * Returns null when the window holds no bars or no volume.
 */
export function buildVpvrProfile(
  bars: readonly Bar[],
  i0: number,
  i1: number,
  rowCount: number,
  valueAreaFrac: number,
): VpvrProfile | null {
  const from = Math.max(0, i0);
  const to = Math.min(bars.length - 1, i1);
  if (from > to) return null;

  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i <= to; i += 1) {
    const b = bars[i] as Bar;
    if (!hasVolume(b)) continue;
    if (b.low < min) min = b.low;
    if (b.high > max) max = b.high;
  }
  if (!Number.isFinite(min)) return null; // no volume in the window

  // A flat window (every bar with volume at one price) still gives a profile: one row.
  const n = max > min ? Math.max(1, Math.round(rowCount)) : 1;
  const rowH = max > min ? (max - min) / n : 1;
  const rows: VpvrRow[] = Array.from({ length: n }, (_, k) => ({ price: min + k * rowH, up: 0, down: 0 }));

  for (let i = from; i <= to; i += 1) {
    const b = bars[i] as Bar;
    if (!hasVolume(b)) continue;
    const v = b.volume;
    const side = b.close >= b.open ? 'up' : 'down';
    const span = b.high - b.low;
    if (span <= 0) {
      // A point bar: all its volume goes to the row that holds its price.
      (rows[clampIndex(Math.floor((b.low - min) / rowH), n)] as VpvrRow)[side] += v;
      continue;
    }
    const kFirst = clampIndex(Math.floor((b.low - min) / rowH), n);
    const kLast = clampIndex(Math.floor((b.high - min) / rowH - 1e-9), n);
    for (let k = kFirst; k <= kLast; k += 1) {
      const rowBot = min + k * rowH;
      const overlap = Math.min(b.high, rowBot + rowH) - Math.max(b.low, rowBot);
      if (overlap > 0) (rows[k] as VpvrRow)[side] += (v * overlap) / span;
    }
  }

  const totalOf = (k: number): number => {
    const r = rows[k] as VpvrRow;
    return r.up + r.down;
  };
  let total = 0;
  let maxTotal = 0;
  let poc = 0;
  for (let k = 0; k < n; k += 1) {
    const t = totalOf(k);
    total += t;
    if (t > maxTotal) {
      maxTotal = t;
      poc = k;
    }
  }
  if (maxTotal <= 0) return null;

  const target = total * Math.min(1, Math.max(0, valueAreaFrac));
  let vaFrom = poc;
  let vaTo = poc;
  let acc = maxTotal;
  while (acc < target && (vaFrom > 0 || vaTo < n - 1)) {
    const below = vaFrom > 0 ? totalOf(vaFrom - 1) : -1;
    const above = vaTo < n - 1 ? totalOf(vaTo + 1) : -1;
    if (above > below) {
      vaTo += 1;
      acc += above;
    } else {
      vaFrom -= 1;
      acc += below;
    }
  }

  return { rows, rowH, min, maxTotal, poc, vaFrom, vaTo };
}
