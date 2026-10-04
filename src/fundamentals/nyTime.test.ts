import { describe, expect, it } from 'vitest';
import { newYorkMidnight } from './nyTime';

const utc = (y: number, m: number, d: number, h: number) => Date.UTC(y, m - 1, d, h) / 1000;

describe('newYorkMidnight', () => {
  it('is 05:00 UTC in winter (EST)', () => {
    expect(newYorkMidnight('2026-01-29')).toBe(utc(2026, 1, 29, 5));
  });

  it('is 04:00 UTC in summer (EDT)', () => {
    expect(newYorkMidnight('2026-07-30')).toBe(utc(2026, 7, 30, 4));
  });

  it('is correct on the DST transition days', () => {
    // Spring forward 2026-03-08 at 02:00: midnight is still EST.
    expect(newYorkMidnight('2026-03-08')).toBe(utc(2026, 3, 8, 5));
    expect(newYorkMidnight('2026-03-09')).toBe(utc(2026, 3, 9, 4));
    // Fall back 2026-11-01 at 02:00: midnight is still EDT.
    expect(newYorkMidnight('2026-11-01')).toBe(utc(2026, 11, 1, 4));
    expect(newYorkMidnight('2026-11-02')).toBe(utc(2026, 11, 2, 5));
  });

  it('returns null for a malformed date', () => {
    expect(newYorkMidnight('29/01/2026')).toBeNull();
  });
});
