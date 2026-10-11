import { CONFLUENCE_MODES, CONFLUENCE_SOURCES, DEFAULT_PARAMS, LIQUIDITY_SWEEP_MODES, LIQUIDITY_ZONE_MODES, PERIOD_MAX, PERIOD_MIN } from '../indicators/types';
import {
  kindLabel,
  PARAM_CHOICES,
  choiceValues,
  createIndicator,
  defaultParams,
  indicatorTitle,
  isFieldShown,
  PARAM_FIELDS,
  parseDecimal,
  parseWholeNumber,
  sanitizeParams,
  validateParams,
} from './config';

describe('validateParams', () => {
  it('accepts the defaults for every kind', () => {
    for (const kind of ['sma', 'ema', 'rsi', 'macd', 'volume', 'vpvr', 'liquidity', 'confluence'] as const) {
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

describe('vpvr config', () => {
  it('always starts blue, even when another indicator has blue', () => {
    const volume = createIndicator('volume', []);
    expect(volume.color).toBe('#2962ff');
    expect(createIndicator('vpvr', [volume]).color).toBe('#2962ff');
  });

  it('defaults to 24 rows, 30% width and a 70% value area, like Vela', () => {
    const v = createIndicator('vpvr', []);
    expect(v.params).toEqual({ rows: 24, widthPct: 30, valueAreaPct: 70 });
    expect(indicatorTitle(v)).toBe('VRVP (24 rows)');
  });

  it('checks each field against its own bounds, not the period bounds', () => {
    expect(validateParams('vpvr', { rows: 400, widthPct: 90, valueAreaPct: 0 })).toEqual({});
    expect(validateParams('vpvr', { rows: 2, widthPct: 5, valueAreaPct: 100 })).toEqual({});
    const bad = validateParams('vpvr', { rows: 1, widthPct: 91, valueAreaPct: 101 });
    expect(bad.rows).toMatch(/between 2 and 400/);
    expect(bad.widthPct).toMatch(/between 5 and 90/);
    expect(bad.valueAreaPct).toMatch(/between 0 and 100/);
  });

  it('sanitizes stored params, and rejects out-of-bounds ones', () => {
    expect(sanitizeParams('vpvr', { rows: 30, widthPct: 25, valueAreaPct: 68, extra: 1 })).toEqual({ rows: 30, widthPct: 25, valueAreaPct: 68 });
    expect(sanitizeParams('vpvr', { rows: 30, widthPct: 95, valueAreaPct: 68 })).toBeNull();
    expect(sanitizeParams('vpvr', { period: 20 })).toBeNull();
  });
});

describe('liquidity config', () => {
  it('is named "Liquidity" and titled "LIQ (lookback)" (decision D2)', () => {
    const l = createIndicator('liquidity', []);
    expect(kindLabel('liquidity')).toBe('Liquidity');
    expect(l.params).toEqual({ lookback: 10, zoneMode: 'wick', sweepMode: 'wicks', minTouches: 0, maxAge: 300, sweepExtend: 20 });
    expect(indicatorTitle(l)).toBe('LIQ (10)');
  });

  it('checks each number field against its own bounds', () => {
    expect(validateParams('liquidity', { lookback: 2, minTouches: 0, maxAge: 10, sweepExtend: 1 })).toEqual({});
    expect(validateParams('liquidity', { lookback: 100, minTouches: 100, maxAge: 5000, sweepExtend: 500 })).toEqual({});
    const bad = validateParams('liquidity', { lookback: 1, minTouches: 101, maxAge: 9, sweepExtend: 0 });
    expect(bad.lookback).toMatch(/between 2 and 100/);
    expect(bad.minTouches).toMatch(/between 0 and 100/);
    expect(bad.maxAge).toMatch(/between 10 and 5000/);
    expect(bad.sweepExtend).toMatch(/between 1 and 500/);
  });

  it('sanitizes stored params, keeps the enum fields, and rejects bad ones', () => {
    const ok = { lookback: 5, zoneMode: 'range', sweepMode: 'both', minTouches: 2, maxAge: 100, sweepExtend: 10 };
    expect(sanitizeParams('liquidity', { ...ok, extra: 1 })).toEqual(ok);
    expect(sanitizeParams('liquidity', { ...ok, zoneMode: 'body' })).toBeNull();
    expect(sanitizeParams('liquidity', { ...ok, sweepMode: undefined })).toBeNull();
    expect(sanitizeParams('liquidity', { ...ok, lookback: 1 })).toBeNull();
    expect(sanitizeParams('liquidity', { period: 20 })).toBeNull();
  });
});

describe('PARAM_CHOICES', () => {
  const values = (kind: 'liquidity' | 'sma', key: string) => PARAM_CHOICES[kind].find((c) => c.key === key)?.options.map((o) => o.value);

  it('offers exactly the enum values the param check accepts', () => {
    expect(values('liquidity', 'zoneMode')).toEqual([...LIQUIDITY_ZONE_MODES]);
    expect(values('liquidity', 'sweepMode')).toEqual([...LIQUIDITY_SWEEP_MODES]);
    expect(values('sma', 'source')).toEqual(['open', 'high', 'low', 'close']);
  });

  it('holds the MA source for SMA and EMA only', () => {
    expect(PARAM_CHOICES.sma.map((c) => c.key)).toEqual(['source']);
    expect(PARAM_CHOICES.ema.map((c) => c.key)).toEqual(['source']);
    for (const kind of ['rsi', 'macd', 'volume', 'vpvr'] as const) expect(PARAM_CHOICES[kind]).toEqual([]);
  });

  it('an optional choice falls back; a required one makes the params invalid', () => {
    expect(choiceValues('sma', { source: 'median' })).toEqual({ source: 'close' });
    expect(choiceValues('sma', {})).toEqual({ source: 'close' });
    expect(choiceValues('liquidity', { zoneMode: 'range', sweepMode: 'both' })).toEqual({ zoneMode: 'range', sweepMode: 'both' });
    expect(choiceValues('liquidity', { zoneMode: 'range' })).toBeNull();
  });

  it('sanitize still turns a bad MA source into close', () => {
    expect(sanitizeParams('ema', { period: 9, source: 'median' })).toEqual({ period: 9, source: 'close' });
  });
});


describe('confluence config', () => {
  const ok = DEFAULT_PARAMS.confluence;
  const shown = (mode: string) =>
    PARAM_FIELDS.confluence.filter((f) => isFieldShown(f, { mode, sources: 'both', latch: 'off' })).map((f) => f.key);

  it('is named "Confluence" and titled with the mode in English (decision D8)', () => {
    const c = createIndicator('confluence', []);
    expect(kindLabel('confluence')).toBe('Confluence');
    expect(c.params).toEqual(ok);
    expect(indicatorTitle(c)).toBe('CONF Turn (250)');
    expect(indicatorTitle({ kind: 'confluence', params: { ...ok, mode: 'breakdown', swingLookback: 100 } })).toBe('CONF Breakdown (100)');
  });

  it('shows the fields of the selected mode only (decision D2)', () => {
    const common = ['swingLookback', 'tolerancePct', 'bandWidthMult', 'pivotLeft', 'pivotRight', 'pivotMaxAge', 'volumeLength', 'volumeMult'];
    expect(shown('turn').sort()).toEqual([...common, 'turnMinConfluence', 'turnMinDistancePct'].sort());
    expect(shown('breakdown').sort()).toEqual([...common, 'breakdownMinConfluence', 'breakdownMinDistancePct', 'closeQuality'].sort());
  });

  it('accepts decimals in decimal fields and rejects them in whole-number fields', () => {
    const nums = { ...ok } as unknown as Record<string, number>;
    expect(validateParams('confluence', { ...nums, tolerancePct: 0.33, volumeMult: 1.25 })).toEqual({});
    expect(validateParams('confluence', { ...nums, swingLookback: 250.5 }).swingLookback).toMatch(/whole number/);
    expect(validateParams('confluence', { ...nums, tolerancePct: Number.NaN }).tolerancePct).toMatch(/must be a number/);
    expect(validateParams('confluence', { ...nums, closeQuality: 1.5 }).closeQuality).toMatch(/between 0.1 and 1/);
  });

  it('sanitizes stored params, keeps latchTime, and rejects bad ones', () => {
    const stored = { ...ok, latch: 'on', latchTime: 1_700_000_000, extra: 1 };
    expect(sanitizeParams('confluence', stored)).toEqual({ ...ok, latch: 'on', latchTime: 1_700_000_000 });
    expect(sanitizeParams('confluence', { ...ok, latchTime: undefined })).toEqual(ok);
    expect(sanitizeParams('confluence', { ...ok, latchTime: -5 })).toBeNull();
    expect(sanitizeParams('confluence', { ...ok, mode: 'sideways' })).toBeNull();
    expect(sanitizeParams('confluence', { ...ok, tolerancePct: 9 })).toBeNull();
    expect(sanitizeParams('confluence', DEFAULT_PARAMS.liquidity)).toBeNull();
  });

  it('offers exactly the enum values the param check accepts, with the mode first', () => {
    const choices = PARAM_CHOICES.confluence;
    expect(choices.map((c) => [c.key, Boolean(c.first)])).toEqual([['mode', true], ['sources', false], ['latch', false]]);
    expect(choices[0]?.options.map((o) => o.value)).toEqual([...CONFLUENCE_MODES]);
    expect(choices[1]?.options.map((o) => o.value)).toEqual([...CONFLUENCE_SOURCES]);
    expect(choices[2]?.options.map((o) => o.value)).toEqual(['off', 'on']);
  });
});

describe('parseDecimal', () => {
  it.each([
    ['0.75', 0.75],
    ['.5', 0.5],
    [' 2 ', 2],
    ['3.', 3],
    ['-1.5', -1.5],
  ])('parses %j', (text, value) => {
    expect(parseDecimal(text)).toBe(value);
  });

  it.each(['', '.', 'abc', '1e3', '1.2.3', '0x10'])('rejects %j', (text) => {
    expect(parseDecimal(text)).toBeNull();
  });
});
