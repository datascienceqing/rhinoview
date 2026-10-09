import { PERIOD_MAX, PERIOD_MIN } from '../indicators/types';
import {
  createIndicator,
  defaultParams,
  indicatorTitle,
  parseWholeNumber,
  sanitizeParams,
  validateParams,
} from './config';

describe('validateParams', () => {
  it('accepts the defaults for every kind', () => {
    for (const kind of ['sma', 'ema', 'rsi', 'macd', 'volume'] as const) {
      const p = defaultParams(kind) as unknown as Record<string, number>;
      expect(validateParams(kind, p)).toEqual({});
    }
  });

  it('accepts both ends of the period bounds', () => {
    expect(validateParams('rsi', { period: PERIOD_MIN })).toEqual({});
    expect(validateParams('rsi', { period: PERIOD_MAX })).toEqual({});
  });

  it.each([PERIOD_MIN - 1, PERIOD_MAX + 1, -5, 0])('rejects period %s as out of range', (period) => {
    expect(validateParams('sma', { period }).period).toMatch(/between 1 and 500/);
  });

  it('rejects fractional and non-finite periods', () => {
    expect(validateParams('ema', { period: 2.5 }).period).toMatch(/whole number/);
    expect(validateParams('ema', { period: Number.NaN }).period).toMatch(/whole number/);
    expect(validateParams('ema', { period: Infinity }).period).toMatch(/whole number/);
  });

  it('requires MACD fast < slow, flagging both fields', () => {
    const equal = validateParams('macd', { fastPeriod: 26, slowPeriod: 26, signalPeriod: 9 });
    expect(equal.fastPeriod).toMatch(/less than slow/);
    expect(equal.slowPeriod).toMatch(/greater than fast/);
    expect(validateParams('macd', { fastPeriod: 30, slowPeriod: 26, signalPeriod: 9 }).fastPeriod).toBeDefined();
    expect(validateParams('macd', { fastPeriod: 25, slowPeriod: 26, signalPeriod: 9 })).toEqual({});
  });

  it('reports a MACD range error instead of an ordering error when a field is out of range', () => {
    const errors = validateParams('macd', { fastPeriod: 0, slowPeriod: 26, signalPeriod: 9 });
    expect(errors.fastPeriod).toMatch(/between/);
    expect(errors.slowPeriod).toBeUndefined();
  });

  it('applies the signal period bounds too', () => {
    expect(validateParams('macd', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 501 }).signalPeriod).toBeDefined();
  });
});

describe('parseWholeNumber', () => {
  it.each([
    ['20', 20],
    [' 7 ', 7],
    ['-3', -3],
    ['0', 0],
  ])('parses %j', (text, n) => expect(parseWholeNumber(text)).toBe(n));

  it.each(['', 'abc', '2.5', '1e2', '--1', '12px'])('rejects %j instead of guessing', (text) => {
    expect(parseWholeNumber(text)).toBeNull();
  });
});

describe('sanitizeParams', () => {
  it('rebuilds params in the right shape for the kind and defaults the MA source', () => {
    expect(sanitizeParams('sma', { period: 10, junk: 1 })).toEqual({ period: 10, source: 'close' });
    expect(sanitizeParams('rsi', { period: 9 })).toEqual({ period: 9 });
    expect(sanitizeParams('macd', { fastPeriod: 5, slowPeriod: 9, signalPeriod: 3 })).toEqual({
      fastPeriod: 5,
      slowPeriod: 9,
      signalPeriod: 3,
    });
  });

  it('returns null for invalid or mistyped params', () => {
    expect(sanitizeParams('sma', { period: 0 })).toBeNull();
    expect(sanitizeParams('sma', { period: '20' })).toBeNull();
    expect(sanitizeParams('sma', null)).toBeNull();
    expect(sanitizeParams('macd', { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 })).toBeNull();
    expect(sanitizeParams('macd', { period: 14 })).toBeNull();
  });

  it('falls back to close for an unknown source', () => {
    expect(sanitizeParams('ema', { period: 5, source: 'vwap' })).toEqual({ period: 5, source: 'close' });
    expect(sanitizeParams('ema', { period: 5, source: 'high' })).toEqual({ period: 5, source: 'high' });
  });
});

describe('createIndicator', () => {
  it('lets two instances of one kind coexist with distinct ids and colours', () => {
    const a = createIndicator('sma', []);
    const b = createIndicator('sma', [a]);
    expect(a.id).not.toBe(b.id);
    expect(a.color).not.toBe(b.color);
    expect(a.kind).toBe(b.kind);
  });

  it('gives each instance its own params object, so editing one cannot change another or the defaults', () => {
    const a = createIndicator('sma', []);
    const b = createIndicator('sma', [a]);
    expect(a.params).not.toBe(b.params);
    (a.params as { period: number }).period = 99;
    expect(defaultParams('sma')).toEqual({ period: 20, source: 'close' });
  });

  it('titles instances by their parameters so two SMAs are distinguishable', () => {
    expect(indicatorTitle({ kind: 'sma', params: { period: 20, source: 'close' } })).toBe('SMA (20)');
    expect(indicatorTitle({ kind: 'sma', params: { period: 50, source: 'high' } })).toBe('SMA (50, high)');
    expect(indicatorTitle({ kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } })).toBe(
      'MACD (12, 26, 9)',
    );
  });
});

describe('volume config', () => {
  it('defaults to a 20-bar MA, titled "Volume (20)"', () => {
    const v = createIndicator('volume', []);
    expect(v.params).toEqual({ period: 20 });
    expect(indicatorTitle(v)).toBe('Volume (20)');
  });

  it('sanitizes stored params to `{ period }`: volume has no price source', () => {
    expect(sanitizeParams('volume', { period: 30, source: 'low' })).toEqual({ period: 30 });
    expect(sanitizeParams('volume', { period: 0 })).toBeNull();
  });
});
