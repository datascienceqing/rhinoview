import { describeError } from './errorCopy';
import { DataError } from '../data';
import { formatChange, formatPercent, formatPrice, formatVolume } from './format';
import { buildLegend } from './legend';
import type { Bar } from '@shared/types';
import type { DataErrorCode } from '../data';

describe('formatPercent', () => {
  it('multiplies the fractional changePercent by 100: 0.0123 is +1.23%', () => {
    expect(formatPercent(0.0123)).toBe('+1.23%');
    expect(formatPercent(-0.05)).toBe('-5.00%');
    expect(formatPercent(0)).toBe('0.00%');
  });
  it('renders null as a dash, never as 0', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPrice(null)).toBe('—');
    expect(formatChange(null)).toBe('—');
    expect(formatVolume(null)).toBe('—');
  });
  it('signs absolute change', () => {
    expect(formatChange(1.456)).toBe('+1.46');
    expect(formatChange(-0.3)).toBe('-0.30');
  });
  it('compacts volume', () => {
    expect(formatVolume(22_850_604)).toBe('22.85M');
  });
});

describe('buildLegend', () => {
  const b = (time: number, open: number, close: number): Bar => ({
    time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1, vwap: null, transactions: null,
  });
  const bars = [b(1, 10, 11), b(2, 11, 12), b(3, 12, 11)];

  it('uses the hovered bar and its change vs the previous close', () => {
    const m = buildLegend(bars, 3);
    expect(m?.bar.time).toBe(3);
    expect(m?.change).toBeCloseTo(-1);
    expect(m?.changePercent).toBeCloseTo(-1 / 12);
  });
  it('falls back to the most recent bar when the crosshair is off the chart or between bars', () => {
    expect(buildLegend(bars, null)?.bar.time).toBe(3);
    expect(buildLegend(bars, 99)?.bar.time).toBe(3);
  });
  it('measures the first bar against its own open', () => {
    expect(buildLegend(bars, 1)?.change).toBeCloseTo(1);
  });
  it('is null with no bars', () => {
    expect(buildLegend([], null)).toBeNull();
  });
});

describe('describeError', () => {
  const codes: DataErrorCode[] = [
    'BAD_REQUEST', 'UNKNOWN_SYMBOL', 'NO_DATA', 'RATE_LIMITED', 'UPSTREAM_ERROR',
    'UPSTREAM_TIMEOUT', 'UNAUTHORIZED', 'INTERNAL', 'NETWORK', 'BAD_RESPONSE', 'ABORTED',
  ];
  it.each(codes)('has human copy for %s that is not a serialised error', (code) => {
    const copy = describeError(new DataError(code, 'RAW SERVER TEXT {"code"}'), 'chart');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.detail).not.toMatch(/RAW SERVER TEXT|[{}]/);
  });
  it('branches on code, not message', () => {
    const a = describeError(new DataError('UNKNOWN_SYMBOL', 'rate limited'), 'chart');
    expect(a.title).toBe('Symbol not found');
  });
  it('pluralises the retry wait', () => {
    expect(describeError(new DataError('RATE_LIMITED', '', { retryAfterSeconds: 1 }), 'chart').detail).toContain('1 second.');
    expect(describeError(new DataError('RATE_LIMITED', '', { retryAfterSeconds: 12 }), 'chart').detail).toContain('12 seconds.');
  });
  it('does not offer retry for an unknown symbol', () => {
    expect(describeError(new DataError('UNKNOWN_SYMBOL', ''), 'chart').retryable).toBe(false);
    expect(describeError(new DataError('NETWORK', ''), 'chart').retryable).toBe(true);
  });
});
