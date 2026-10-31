/**
 * Market structure for the AI facts: swings, BOS and CHoCH events, the dealing range, fib
 * levels, and order blocks. Our own definitions, written down here so that the skill text
 * and the numbers agree:
 *
 * - A swing is a pivot with `SWING_SIDE` bars on each side (`src/indicators/pivots.ts`).
 *   It is known only `SWING_SIDE` bars later, and nothing uses it before that bar.
 * - A break is the first CLOSE past the latest known swing high (bullish) or swing low
 *   (bearish). Each swing breaks once. A wick past the level is not a break.
 * - The first break against the current trend is a CHoCH; a break with the trend is a BOS.
 *   The very first break sets the trend and counts as a BOS.
 * - An order block is the last opposite candle (close against the break) between the
 *   swing that the break started from and the break bar. Its zone is the candle's high to
 *   low. It is removed when a later close passes its far edge.
 */
import type { Bar } from '@shared/types';
import { isPivotHigh, isPivotLow } from '../../../src/indicators/pivots';

export const SWING_SIDE = 5;

export type Side = 'bullish' | 'bearish';

export interface Swing {
  kind: 'high' | 'low';
  index: number;
  time: number;
  price: number;
  /** The bar where the swing becomes known. */
  confirmedIndex: number;
}

export interface StructureEvent {
  kind: 'BOS' | 'CHoCH';
  side: Side;
  /** The swing level that the close passed. */
  level: number;
  /** The breaking bar. */
  index: number;
  time: number;
}

export interface Zone {
  side: Side;
  top: number;
  bottom: number;
  /** The candle of the zone. */
  index: number;
  time: number;
  /** The bar that made the zone: for an order block, the break bar. */
  createdIndex: number;
  /** A bar after `createdIndex` entered the zone. */
  touched: boolean;
  /** The last close is inside the zone. */
  priceInside: boolean;
}

export interface Structure {
  swings: Swing[];
  events: StructureEvent[];
  trend: Side | null;
  orderBlocks: Zone[];
}

export function findSwings(bars: readonly Bar[], side = SWING_SIDE): Swing[] {
  const out: Swing[] = [];
  for (let i = side; i < bars.length - side; i++) {
    const b = bars[i] as Bar;
    if (isPivotHigh(bars, i, side, side)) out.push({ kind: 'high', index: i, time: b.time, price: b.high, confirmedIndex: i + side });
    if (isPivotLow(bars, i, side, side)) out.push({ kind: 'low', index: i, time: b.time, price: b.low, confirmedIndex: i + side });
  }
  return out;
}

/** Up to `max` unmitigated order blocks, newest first. */
export function analyzeStructure(bars: readonly Bar[], max = 4, side = SWING_SIDE): Structure {
  const swings = findSwings(bars, side);
  const events: StructureEvent[] = [];
  const blocks: Zone[] = [];
  let trend: Side | null = null;
  let high: Swing | null = null;
  let low: Swing | null = null;
  let highUsed = true;
  let lowUsed = true;
  let s = 0;
  const known = [...swings].sort((a, b) => a.confirmedIndex - b.confirmedIndex);

  for (let i = 0; i < bars.length; i++) {
    while (s < known.length && (known[s] as Swing).confirmedIndex <= i) {
      const sw = known[s] as Swing;
      if (sw.kind === 'high') {
        high = sw;
        highUsed = false;
      } else {
        low = sw;
        lowUsed = false;
      }
      s++;
    }
    const bar = bars[i] as Bar;
    const prev = bars[i - 1];
    if (!prev) continue;
    for (const [sw, used, dir] of [
      [high, highUsed, 'bullish'],
      [low, lowUsed, 'bearish'],
    ] as const) {
      if (!sw || used) continue;
      const broke = dir === 'bullish' ? bar.close > sw.price && prev.close <= sw.price : bar.close < sw.price && prev.close >= sw.price;
      if (!broke) continue;
      events.push({ kind: trend !== null && trend !== dir ? 'CHoCH' : 'BOS', side: dir, level: sw.price, index: i, time: bar.time });
      trend = dir;
      if (dir === 'bullish') highUsed = true;
      else lowUsed = true;
      const block = orderBlockFor(bars, dir, dir === 'bullish' ? low : high, i);
      if (block) blocks.push(block);
    }
    // A close past the far edge removes a block.
    for (let k = blocks.length - 1; k >= 0; k--) {
      const z = blocks[k] as Zone;
      if (i <= z.createdIndex) continue;
      if ((z.side === 'bullish' && bar.close < z.bottom) || (z.side === 'bearish' && bar.close > z.top)) blocks.splice(k, 1);
    }
  }

  const lastClose = bars[bars.length - 1]?.close ?? NaN;
  for (const z of blocks) {
    z.touched = bars.some((b, j) => j > z.createdIndex && b.low <= z.top && b.high >= z.bottom);
    z.priceInside = lastClose >= z.bottom && lastClose <= z.top;
  }
  return { swings, events, trend, orderBlocks: blocks.reverse().slice(0, max) };
}

/** The last opposite candle between the origin swing and the break bar. */
function orderBlockFor(bars: readonly Bar[], side: Side, origin: Swing | null, breakIndex: number): Zone | null {
  const from = origin ? origin.index : Math.max(0, breakIndex - 20);
  for (let j = breakIndex - 1; j >= from; j--) {
    const b = bars[j] as Bar;
    const opposite = side === 'bullish' ? b.close < b.open : b.close > b.open;
    if (opposite) return { side, top: b.high, bottom: b.low, index: j, time: b.time, createdIndex: breakIndex, touched: false, priceInside: false };
  }
  return null;
}

export interface DealingRange {
  high: number;
  low: number;
  equilibrium: number;
  /** 0 at the range low, 100 at the range high. */
  positionPct: number;
  zone: 'premium' | 'discount' | 'equilibrium';
}

/**
 * The dealing range: from the older of the latest known swing high and swing low to now,
 * the highest high and the lowest low. A break past a swing extends the range, so the last
 * close is always inside it. Null without both swings.
 */
export function dealingRange(bars: readonly Bar[], swings: readonly Swing[]): DealingRange | null {
  const n = bars.length;
  const knownHigh = [...swings].reverse().find((s) => s.kind === 'high' && s.confirmedIndex < n);
  const knownLow = [...swings].reverse().find((s) => s.kind === 'low' && s.confirmedIndex < n);
  const close = bars[n - 1]?.close;
  if (!knownHigh || !knownLow || close === undefined) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = Math.min(knownHigh.index, knownLow.index); i < n; i++) {
    high = Math.max(high, (bars[i] as Bar).high);
    low = Math.min(low, (bars[i] as Bar).low);
  }
  if (high <= low) return null;
  const positionPct = ((close - low) / (high - low)) * 100;
  const zone = positionPct > 52 ? 'premium' : positionPct < 48 ? 'discount' : 'equilibrium';
  return { high, low, equilibrium: (high + low) / 2, positionPct, zone };
}

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.786, 1] as const;

export interface FibLevel {
  ratio: number;
  name: string;
  price: number;
}

export interface Fib {
  direction: 'up' | 'down';
  /** The leg: `from` is its start, `to` its end. */
  from: { price: number; time: number };
  to: { price: number; time: number };
  /** How far price has come back from `to` toward `from`, in %. Over 100 is past the start. */
  retracementPct: number;
  goldenPocket: boolean;
  levels: FibLevel[];
  /** The nearest level above and below the last close. */
  above: FibLevel | null;
  below: FibLevel | null;
}

function fibName(r: number): string {
  if (r === 0) return '0 (leg end)';
  if (r === 1) return '1 (leg start)';
  return r === 0.65 ? '0.65 (golden pocket edge)' : String(r);
}

/**
 * Retracement levels of the last leg between the extreme swings of the last `lookback`
 * bars. Usually computed on 1W bars, so the leg is the major swing.
 */
export function fibOfLastLeg(bars: readonly Bar[], lookback = 260): Fib | null {
  const n = bars.length;
  const close = bars[n - 1]?.close;
  if (n < 10 || close === undefined) return null;
  const start = Math.max(0, n - lookback);
  let hi = start;
  let lo = start;
  for (let i = start; i < n; i++) {
    if ((bars[i] as Bar).high > (bars[hi] as Bar).high) hi = i;
    if ((bars[i] as Bar).low < (bars[lo] as Bar).low) lo = i;
  }
  const H = bars[hi] as Bar;
  const L = bars[lo] as Bar;
  if (H.high <= L.low) return null;
  const direction = lo < hi ? 'up' : 'down';
  const span = H.high - L.low;
  const levels = FIB_RATIOS.map((r) => ({
    ratio: r,
    name: fibName(r),
    price: direction === 'up' ? H.high - r * span : L.low + r * span,
  }));
  const retracementPct = (direction === 'up' ? (H.high - close) / span : (close - L.low) / span) * 100;
  const sortedUp = [...levels].sort((a, b) => a.price - b.price);
  return {
    direction,
    from: direction === 'up' ? { price: L.low, time: L.time } : { price: H.high, time: H.time },
    to: direction === 'up' ? { price: H.high, time: H.time } : { price: L.low, time: L.time },
    retracementPct,
    goldenPocket: retracementPct >= 61.8 && retracementPct <= 65,
    levels,
    above: sortedUp.find((l) => l.price > close) ?? null,
    below: [...sortedUp].reverse().find((l) => l.price < close) ?? null,
  };
}
