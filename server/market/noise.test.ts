import { describe, expect, it } from 'vitest';
import { PATH_STRIDE, PricePath, hash32, hashString, unit } from './noise';

describe('hashing', () => {
  it('is a pure function with pinned values (guards against accidental changes to every price)', () => {
    expect(hash32(1, 2)).toBe(2334715726);
    expect(hash32(0, 0)).toBe(1448752839);
    expect(hash32(-5, 123456)).toBe(2429362479);
    expect(hashString('AAPL')).toBe(hashString('AAPL'));
    expect(hashString('AAPL')).not.toBe(hashString('AAPM'));
  });

  it('maps to [0, 1) and is roughly uniform', () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const u = unit(hash32(7, i));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
  });
});

describe('price path (invariant 1: pure function of seed and index)', () => {
  it('gives identical values from a sequential cursor, a fresh cursor, and a scrambled order', () => {
    const path = new PricePath(42, 100, 0.02, 0);
    const sequential = path.cursor();
    const indices = Array.from({ length: 3000 }, (_, i) => 1_000_000 + i);
    const seq = indices.map((i) => sequential.logPrice(i));

    const scrambled = [...indices].sort((a, b) => ((a * 2654435761) % 1013) - ((b * 2654435761) % 1013));
    const shared = path.cursor();
    for (const i of scrambled) {
      expect(shared.logPrice(i)).toBe(seq[i - 1_000_000]);
    }
    const fresh = new PricePath(42, 100, 0.02, 0).cursor();
    expect(fresh.logPrice(1_001_234)).toBe(seq[1234]);
  });

  it('passes through the base price at the anchor', () => {
    const anchor = 400 * PATH_STRIDE;
    const path = new PricePath(9, 187.5, 0.03, anchor);
    expect(Math.exp(path.cursor().logPrice(anchor))).toBeCloseTo(187.5, 9);
  });

  it('differs between seeds', () => {
    const a = new PricePath(1, 100, 0.02, 0).cursor();
    const b = new PricePath(2, 100, 0.02, 0).cursor();
    expect(a.logPrice(777_777)).not.toBe(b.logPrice(777_777));
  });

  it('honours the requested daily volatility (calibration guard, within 10%)', () => {
    const target = 0.02;
    for (const seed of [11, 22, 33, 44]) {
      const c = new PricePath(seed, 100, target, 0).cursor();
      let s2 = 0;
      let n = 0;
      for (let i = 100_000; i < 2_000_000; i += 997) {
        const d = c.logPrice(i + PATH_STRIDE) - c.logPrice(i);
        s2 += d * d;
        n++;
      }
      const sd = Math.sqrt(s2 / n);
      expect(sd / target, `seed ${seed}`).toBeGreaterThan(0.9);
      expect(sd / target, `seed ${seed}`).toBeLessThan(1.1);
    }
  });

  it('scales like a random walk: variance of a move grows ~linearly with lag', () => {
    const c = new PricePath(5, 100, 0.02, 0).cursor();
    const sdAt = (lag: number): number => {
      let s2 = 0;
      let n = 0;
      for (let i = 200_000; i < 1_800_000; i += 1009) {
        const d = c.logPrice(i + lag) - c.logPrice(i);
        s2 += d * d;
        n++;
      }
      return Math.sqrt(s2 / n);
    };
    const ratio = sdAt(PATH_STRIDE * 5) / sdAt(PATH_STRIDE); // sqrt(5) ~ 2.24 for a random walk
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.6);
  });
});
