import type { AlertCondition } from '@shared/types';
import { MAX_ALERT_MESSAGE_LENGTH } from '@shared/types';
import { ALERT_SYMBOL_RE, checkAlertCondition, checkAlertMessage } from './condition';

const price = (level: number, direction: AlertCondition['direction'] = 'cross'): AlertCondition => ({ type: 'price', direction, level });

const macd = (line: string, target: Extract<AlertCondition, { type: 'indicator' }>['target']): AlertCondition => ({
  type: 'indicator',
  timeframe: '1D',
  indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  line,
  direction: 'up',
  target,
});

describe('checkAlertCondition: price', () => {
  it('accepts a positive finite level in each direction', () => {
    for (const d of ['cross', 'up', 'down'] as const) expect(checkAlertCondition(price(187.25, d))).toBeNull();
  });

  it('rejects a level that is not a positive finite number', () => {
    for (const level of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkAlertCondition(price(level))).toMatch(/level/);
    }
  });

  it('rejects an unknown direction', () => {
    expect(checkAlertCondition(price(10, 'sideways' as never))).toMatch(/direction/);
  });
});

describe('checkAlertCondition: indicator', () => {
  it('accepts MACD against its signal line, a value, and the close', () => {
    expect(checkAlertCondition(macd('macd', { type: 'line', line: 'signal' }))).toBeNull();
    expect(checkAlertCondition(macd('histogram', { type: 'value', value: 0 }))).toBeNull();
    expect(checkAlertCondition(macd('macd', { type: 'close' }))).toBeNull();
  });

  it('accepts SMA, EMA and RSI with valid params', () => {
    const base = { type: 'indicator', timeframe: '1h', line: 'value', direction: 'cross' } as const;
    expect(checkAlertCondition({ ...base, indicator: { kind: 'sma', params: { period: 20, source: 'close' } }, target: { type: 'close' } })).toBeNull();
    expect(checkAlertCondition({ ...base, indicator: { kind: 'ema', params: { period: 50, source: 'close' } }, target: { type: 'close' } })).toBeNull();
    expect(checkAlertCondition({ ...base, indicator: { kind: 'rsi', params: { period: 14 } }, target: { type: 'value', value: 70 } })).toBeNull();
  });

  it('rejects indicators that cannot have alerts', () => {
    const c = { ...macd('value', { type: 'close' }), indicator: { kind: 'vpvr', params: {} } } as unknown as AlertCondition;
    expect(checkAlertCondition(c)).toMatch(/indicator must be one of/);
  });

  it('rejects invalid params with the indicator message', () => {
    const c = macd('macd', { type: 'close' });
    if (c.type !== 'indicator') throw new Error('unreachable');
    c.indicator.params = { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 };
    expect(checkAlertCondition(c)).not.toBeNull();
  });

  it('rejects an unknown line, an unknown target line, and a line against itself', () => {
    expect(checkAlertCondition(macd('value', { type: 'close' }))).toMatch(/^line must be one of/);
    expect(checkAlertCondition(macd('macd', { type: 'line', line: 'value' }))).toMatch(/target line must be one of/);
    expect(checkAlertCondition(macd('signal', { type: 'line', line: 'signal' }))).toMatch(/differ/);
  });

  it('rejects a target value that is not finite', () => {
    expect(checkAlertCondition(macd('macd', { type: 'value', value: Number.NaN }))).toMatch(/finite/);
  });
});

describe('checkAlertMessage and ALERT_SYMBOL_RE', () => {
  it('limits the message length', () => {
    expect(checkAlertMessage('')).toBeNull();
    expect(checkAlertMessage('x'.repeat(MAX_ALERT_MESSAGE_LENGTH))).toBeNull();
    expect(checkAlertMessage('x'.repeat(MAX_ALERT_MESSAGE_LENGTH + 1))).toMatch(/at most/);
  });

  it('uses the workspace symbol format', () => {
    for (const s of ['AAPL', 'brk.b', '^GSPC', 'EURUSD=X']) expect(ALERT_SYMBOL_RE.test(s)).toBe(true);
    for (const s of ['', 'A B', 'X'.repeat(17), 'A/B']) expect(ALERT_SYMBOL_RE.test(s)).toBe(false);
  });
});
