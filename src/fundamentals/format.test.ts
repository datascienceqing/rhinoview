import { describe, expect, it } from 'vitest';
import {
  DASH,
  fiscalLabel,
  formatFraction,
  formatFractionTick,
  formatLarge,
  formatLargeTick,
  formatSignedPercent,
  marginCell,
  multipleCell,
} from './format';

describe('format', () => {
  it('writes axis ticks with no trailing zeros', () => {
    expect(formatLargeTick(400e9)).toBe('400B');
    expect(formatLargeTick(2.5e9)).toBe('2.5B');
    expect(formatLargeTick(-500e6)).toBe('-500M');
    expect(formatLargeTick(0)).toBe('0');
    expect(formatFractionTick(0.1)).toBe('10%');
    expect(formatFractionTick(0.025)).toBe('2.5%');
  });

  it('shows null as a dash, never as zero', () => {
    expect(formatFraction(null)).toBe(DASH);
    expect(formatLarge(null)).toBe(DASH);
    expect(multipleCell(null)).toEqual({ text: DASH });
    expect(marginCell(null, false)).toEqual({ text: DASH });
  });

  it('turns fractions into percentages', () => {
    expect(formatFraction(0.4865)).toBe('48.65%');
    expect(formatFraction(0.0032)).toBe('0.32%');
  });

  it('shows a zero or negative valuation multiple as NM with a reason', () => {
    expect(multipleCell(-5.54)).toEqual({ text: 'NM', title: 'not meaningful: negative earnings' });
    expect(multipleCell(0).text).toBe('NM');
    expect(multipleCell(28.9).text).toBe('28.90x');
  });

  it('shows NM, with the reason, only when the server marks the margin as not meaningful', () => {
    expect(marginCell(0.626, true)).toEqual({ text: 'NM', title: expect.stringMatching(/interest expense/) });
    expect(marginCell(0.626, false).text).toBe('62.60%');
  });

  it('formats large amounts with T, B and M', () => {
    expect(formatLarge(1_270_381_000_000)).toBe('1.27T');
    expect(formatLarge(394_328_000_000)).toBe('394.33B');
    expect(formatLarge(-5_250_000)).toBe('-5.25M');
    expect(formatLarge(12_345)).toBe('12,345');
  });

  it('signs surprise percentages', () => {
    expect(formatSignedPercent(5.2)).toBe('+5.20%');
    expect(formatSignedPercent(-3)).toBe('-3.00%');
  });

  it('labels fiscal periods from the provider, not the calendar', () => {
    expect(fiscalLabel({ fiscalYear: 2026, fiscalPeriod: 'FY' })).toBe('FY2026');
    expect(fiscalLabel({ fiscalYear: 2026, fiscalPeriod: 'Q1' })).toBe('Q1 FY2026');
  });
});
