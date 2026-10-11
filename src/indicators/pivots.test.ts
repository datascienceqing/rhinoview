import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { isPivotHigh, isPivotLow } from './pivots';

/** Bars with the given highs; each low is the high minus 10. */
function fromHighs(highs: readonly number[]): Bar[] {
  return highs.map((high, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: high - 5,
    high,
    low: high - 10,
    close: high - 5,
    volume: 100,
    vwap: null,
    transactions: null,
  }));
}

describe('isPivotHigh', () => {
  it('uses separate left and right counts', () => {
    // Bar 3 is above the 3 bars before it and the 1 bar after it, but not above bar 5.
    const b = fromHighs([10, 11, 12, 20, 15, 25]);
    expect(isPivotHigh(b, 3, 3, 1)).toBe(true);
    expect(isPivotHigh(b, 3, 3, 2)).toBe(false);
    expect(isPivotHigh(b, 3, 2, 1)).toBe(true);
  });

  it('is strict on the left and not strict on the right', () => {
    const flat = fromHighs([10, 20, 20, 10]);
    expect(isPivotHigh(flat, 1, 1, 1)).toBe(true); // the first bar of a flat top
    expect(isPivotHigh(flat, 2, 1, 1)).toBe(false);
  });
});

describe('isPivotLow', () => {
  it('mirrors the high rule with separate counts', () => {
    const b = fromHighs([30, 29, 28, 20, 25, 15]);
    expect(isPivotLow(b, 3, 3, 1)).toBe(true);
    expect(isPivotLow(b, 3, 3, 2)).toBe(false);
    const flat = fromHighs([30, 20, 20, 30]);
    expect(isPivotLow(flat, 1, 1, 1)).toBe(true);
    expect(isPivotLow(flat, 2, 1, 1)).toBe(false);
  });
});
