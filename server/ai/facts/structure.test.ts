import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { analyzeStructure, dealingRange, fibOfLastLeg, findSwings } from './structure';

/** Bars that follow `closes`, each 1 wide around its close, with open = previous close. */
function path(closes: number[]): Bar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1] as number);
    return { time: i * 86_400, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000, vwap: null, transactions: null };
  });
}

/** A line from a to b in `steps` bars, not including a. */
const leg = (a: number, b: number, steps: number) => Array.from({ length: steps }, (_, i) => a + ((b - a) * (i + 1)) / steps);

describe('findSwings', () => {
  it('finds a peak and a trough with 5 bars on each side', () => {
    const bars = path([...leg(100, 110, 10), ...leg(110, 100, 10), ...leg(100, 105, 10)]);
    const swings = findSwings(bars);
    expect(swings.map((s) => s.kind)).toEqual(['high', 'low']);
    expect(swings[0]?.confirmedIndex).toBe((swings[0]?.index ?? 0) + 5);
  });
});

describe('analyzeStructure', () => {
  // Up to a high at 120, down to a low at 105, up past 120 (BOS), down past 105 (CHoCH).
  const closes = [100, ...leg(100, 120, 10), ...leg(120, 105, 10), ...leg(105, 125, 12), ...leg(125, 100, 15)];
  const bars = path(closes);
  const s = analyzeStructure(bars);

  it('needs a close past the swing, not a wick', () => {
    const first = s.events[0];
    expect(first?.side).toBe('bullish');
    expect((bars[first?.index ?? 0] as Bar).close).toBeGreaterThan(first?.level ?? Infinity);
    expect((bars[(first?.index ?? 1) - 1] as Bar).close).toBeLessThanOrEqual(first?.level ?? 0);
  });

  it('calls a break against the trend a CHoCH', () => {
    expect(s.events.map((e) => `${e.kind}:${e.side}`)).toEqual(['BOS:bullish', 'CHoCH:bearish']);
    expect(s.trend).toBe('bearish');
  });

  it('removes an order block after a close past its far edge', () => {
    // The bullish block sits below 105; the fall to 100 closes under it.
    expect(s.orderBlocks.every((z) => z.side === 'bearish')).toBe(true);
  });

  it('marks a block as touched only by a bar after the break', () => {
    for (const z of s.orderBlocks) {
      const after = bars.slice(z.createdIndex + 1).some((b) => b.low <= z.top && b.high >= z.bottom);
      expect(z.touched).toBe(after);
    }
  });
});

describe('dealingRange', () => {
  it('gives the equilibrium and the zone of the last close', () => {
    const bars = path([100, ...leg(100, 120, 10), ...leg(120, 100, 10), ...leg(100, 104, 8)]);
    const r = dealingRange(bars, findSwings(bars));
    expect(r?.equilibrium).toBeCloseTo(((r?.high ?? 0) + (r?.low ?? 0)) / 2, 10);
    expect(r?.zone).toBe('discount');
  });

  it('extends past a broken swing, so the close stays inside the range', () => {
    const bars = path([100, ...leg(100, 120, 10), ...leg(120, 105, 10), ...leg(105, 112, 6), ...leg(112, 95, 6)]);
    const r = dealingRange(bars, findSwings(bars));
    expect(r?.low).toBeLessThan(105);
    expect(r?.positionPct).toBeGreaterThanOrEqual(0);
    expect(r?.positionPct).toBeLessThanOrEqual(100);
  });
});

describe('fibOfLastLeg', () => {
  it('reproduces the SNDK levels of sample 004', () => {
    // Leg 1,504.20 → 1,909.48, price 1,660.46: 0.5 = 1,706.84, 0.618 = 1,659.02, 0.786 = 1,590.93.
    const bars: Bar[] = [
      { time: 0, open: 1510, high: 1520, low: 1504.2, close: 1515, volume: 1, vwap: null, transactions: null },
      ...Array.from({ length: 8 }, (_, i) => ({ time: (i + 1) * 604_800, open: 1600, high: 1700 + i * 20, low: 1590, close: 1650, volume: 1, vwap: null, transactions: null })),
      { time: 9 * 604_800, open: 1850, high: 1909.48, low: 1800, close: 1880, volume: 1, vwap: null, transactions: null },
      { time: 10 * 604_800, open: 1700, high: 1710, low: 1655, close: 1660.46, volume: 1, vwap: null, transactions: null },
    ];
    const f = fibOfLastLeg(bars);
    const at = (r: number) => f?.levels.find((l) => l.ratio === r)?.price;
    expect(f?.direction).toBe('up');
    expect(at(0.5)).toBeCloseTo(1706.84, 2);
    expect(at(0.618)).toBeCloseTo(1659.02, 2);
    expect(at(0.786)).toBeCloseTo(1590.93, 2);
    expect(f?.retracementPct).toBeCloseTo(61.44, 2);
    // 61.44% is just short of the 61.8–65% golden pocket.
    expect(f?.goldenPocket).toBe(false);
    expect(f?.above?.ratio).toBe(0.5);
    expect(f?.below?.ratio).toBe(0.618);
  });
});
