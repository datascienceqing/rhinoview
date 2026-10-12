/**
 * Liquidity zones at swing pivots, and sweeps of those zones.
 *
 * The specification is docs/LIQUIDITY_PLAN.md, section 4. This is our own implementation
 * of it (clean room, plan section 2). Pure: bars and params in, zones and sweeps out.
 *
 * One pass over the bars. At each bar it confirms at most one high and one low pivot,
 * updates the active zones, checks the broken zones for a retest, and closes sweep areas.
 * The work per bar is O(L + active zones); zones close by break or by age, so the active
 * list stays short.
 *
 * Where section 4 leaves a choice, this file takes the simplest reading:
 *  - A pivot needs L full bars on each side, so `L <= i <= n - 1 - L`.
 *  - A zone is active through bar `i + maxAge`. On that bar a break wins over expiry, and a
 *    wick sweep can still happen.
 *  - With `maxAge <= L`, a zone is already expired at its confirmation bar. It has no sweeps.
 *  - A sweep is shown when the touch count it carries (at its sweep bar) is >= minTouches.
 */
import type { Bar, LiquidityParams } from '@shared/types';
import { assertValidParams } from './params';
import { isPivotHigh, isPivotLow } from './pivots';

export type LiquiditySide = 'high' | 'low';
export type LiquidityDirection = 'bullish' | 'bearish';

export interface LiquidityZone {
  /** Stable within one data set: side and the pivot bar's time. */
  id: string;
  side: LiquiditySide;
  pivotIndex: number;
  pivotTime: number;
  /** `pivotIndex + L`: the first bar that knows the zone. */
  confirmIndex: number;
  top: number;
  bottom: number;
  /** The outer edge: `top` for a high zone, `bottom` for a low zone. */
  level: number;
  /** 'active' at the last bar, or how it closed. */
  status: 'active' | 'broken' | 'expired';
  /** The bar where the zone closed, or the last bar while it is active. */
  endIndex: number;
  /** Bars after the pivot bar, up to `endIndex`, whose range overlaps the zone. */
  touches: number;
  /** The volume of those bars. */
  volume: number;
}

export interface LiquiditySweep {
  id: string;
  zoneId: string;
  side: LiquiditySide;
  kind: 'wick' | 'retest';
  direction: LiquidityDirection;
  index: number;
  time: number;
  /** The zone level `p` that the bar went through. */
  level: number;
  /** The wick extreme of the sweep bar: its high when bearish, its low when bullish. */
  extreme: number;
  /** Where the sweep area ends (section 4.6). */
  endIndex: number;
  /** True while the end can still move: no invalidating close yet, and less than `sweepExtend` bars. */
  open: boolean;
  /** The zone's touch count and volume at the sweep bar (section 4.7). */
  touches: number;
  volume: number;
}

export interface LiquidityResult {
  zones: LiquidityZone[];
  sweeps: LiquiditySweep[];
}

interface ZoneState {
  zone: LiquidityZone;
  wickDone: boolean;
}

interface RetestWait {
  zone: LiquidityZone;
  /** Last bar where a retest can happen: `pivotIndex + maxAge`. */
  until: number;
}

function makeZone(bars: readonly Bar[], side: LiquiditySide, i: number, L: number, mode: LiquidityParams['zoneMode']): LiquidityZone {
  const b = bars[i] as Bar;
  let top: number;
  let bottom: number;
  if (mode === 'range') {
    top = b.high;
    bottom = b.low;
  } else if (side === 'high') {
    top = b.high;
    bottom = Math.max(b.open, b.close);
  } else {
    top = Math.min(b.open, b.close);
    bottom = b.low;
  }
  return {
    id: `${side}-${b.time}`,
    side,
    pivotIndex: i,
    pivotTime: b.time,
    confirmIndex: i + L,
    top,
    bottom,
    level: side === 'high' ? top : bottom,
    status: 'active',
    endIndex: i + L,
    touches: 0,
    volume: 0,
  };
}

function touch(zone: LiquidityZone, bar: Bar): void {
  if (bar.low < zone.top && bar.high > zone.bottom) {
    zone.touches += 1;
    zone.volume += bar.volume;
  }
}

/** Zones and sweeps for `bars` (ascending by time). Throws on invalid params. */
export function computeLiquidity(bars: readonly Bar[], params: LiquidityParams): LiquidityResult {
  assertValidParams('liquidity', params);
  const { lookback: L, zoneMode, sweepMode, minTouches, maxAge, sweepExtend } = params;
  const wantWicks = sweepMode === 'wicks' || sweepMode === 'both';
  const wantRetests = sweepMode === 'retests' || sweepMode === 'both';
  const n = bars.length;

  const zones: LiquidityZone[] = [];
  const sweeps: LiquiditySweep[] = [];
  let active: ZoneState[] = [];
  let waiting: RetestWait[] = [];
  let openSweeps: LiquiditySweep[] = [];

  const addSweep = (zone: LiquidityZone, kind: LiquiditySweep['kind'], j: number) => {
    const bar = bars[j] as Bar;
    const bearish = (zone.side === 'high') === (kind === 'wick');
    const sweep: LiquiditySweep = {
      id: `${zone.id}-${kind}`,
      zoneId: zone.id,
      side: zone.side,
      kind,
      direction: bearish ? 'bearish' : 'bullish',
      index: j,
      time: bar.time,
      level: zone.level,
      extreme: bearish ? bar.high : bar.low,
      endIndex: j,
      open: true,
      touches: zone.touches,
      volume: zone.volume,
    };
    sweeps.push(sweep);
    openSweeps.push(sweep);
  };

  for (let j = 0; j < n; j++) {
    const bar = bars[j] as Bar;

    // 1. Sweep areas that started earlier: the first close past the extreme, or the length, ends them.
    openSweeps = openSweeps.filter((s) => {
      const past = s.direction === 'bearish' ? bar.close > s.extreme : bar.close < s.extreme;
      if (past || j >= s.index + sweepExtend) {
        s.endIndex = j;
        s.open = false;
        return false;
      }
      s.endIndex = j;
      return true;
    });

    // 2. Retests of zones that broke on an earlier bar.
    waiting = waiting.filter((w) => {
      if (j > w.until) return false;
      const p = w.zone.level;
      const retest = w.zone.side === 'high' ? bar.low < p && bar.close > p : bar.high > p && bar.close < p;
      if (!retest) return true;
      addSweep(w.zone, 'retest', j);
      return false;
    });

    // 3. Zones confirmed on an earlier bar: touch, break, wick sweep, expiry.
    const stillActive: ZoneState[] = [];
    for (const st of active) {
      const z = st.zone;
      touch(z, bar);
      z.endIndex = j;
      const p = z.level;
      const broke = z.side === 'high' ? bar.close > z.top : bar.close < z.bottom;
      if (broke) {
        z.status = 'broken';
        if (wantRetests) waiting.push({ zone: z, until: z.pivotIndex + maxAge });
        continue;
      }
      if (wantWicks && !st.wickDone) {
        const wick = z.side === 'high' ? bar.high > p && bar.close <= p : bar.low < p && bar.close >= p;
        if (wick) {
          st.wickDone = true;
          addSweep(z, 'wick', j);
        }
      }
      if (j - z.pivotIndex >= maxAge) {
        z.status = 'expired';
        continue;
      }
      stillActive.push(st);
    }
    active = stillActive;

    // 4. Pivots confirmed on this bar. They become active from this bar: no break or sweep yet.
    const i = j - L;
    if (i >= L) {
      for (const side of ['high', 'low'] as const) {
        const isPivot = side === 'high' ? isPivotHigh(bars, i, L, L) : isPivotLow(bars, i, L, L);
        if (!isPivot) continue;
        const z = makeZone(bars, side, i, L, zoneMode);
        const last = Math.min(j, i + maxAge);
        for (let k = i + 1; k <= last; k++) touch(z, bars[k] as Bar);
        z.endIndex = last;
        zones.push(z);
        if (i + maxAge <= j) z.status = 'expired';
        else active.push({ zone: z, wickDone: false });
      }
    }
  }

  return {
    zones: zones.filter((z) => z.touches >= minTouches),
    sweeps: sweeps.filter((s) => s.touches >= minTouches),
  };
}
