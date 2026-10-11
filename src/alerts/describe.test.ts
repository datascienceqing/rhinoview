import type { Alert, AlertCondition, AlertEvent } from '@shared/types';
import { applyLocale } from '../i18n/locale';
import { defaultMessage, intervalText, matchesSearch, messageOf, sortAlerts, sortEvents, summaryOf } from './describe';

const price: AlertCondition = { type: 'price', direction: 'cross', level: 190 };
const rsi: AlertCondition = { type: 'indicator', timeframe: '1D', indicator: { kind: 'rsi', params: { period: 14 } }, line: 'value', direction: 'up', target: { type: 'value', value: 70 } };
const macd: AlertCondition = {
  type: 'indicator', timeframe: '1D', indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } }, line: 'macd', direction: 'down', target: { type: 'line', line: 'signal' },
};
const sma: AlertCondition = { type: 'indicator', timeframe: '1h', indicator: { kind: 'sma', params: { period: 50, source: 'close' } }, line: 'value', direction: 'cross', target: { type: 'close' } };

describe('alert text', () => {
  it('writes the default message in English', () => {
    expect(defaultMessage('AAPL', price)).toBe('AAPL crossing 190.00');
    expect(defaultMessage('NVDA', rsi)).toBe('NVDA RSI (14) crossing up 70');
    expect(defaultMessage('MSFT', macd)).toBe('MSFT MACD (12, 26, 9) MACD crossing down Signal');
    expect(defaultMessage('TSLA', sma)).toBe('TSLA SMA (50) crossing close');
  });

  it('writes the default message in Chinese, with indicator names in English', () => {
    applyLocale('zh');
    expect(defaultMessage('AAPL', price)).toBe('AAPL 穿越 190.00');
    expect(defaultMessage('NVDA', rsi)).toBe('NVDA RSI (14) 向上穿越 70');
    expect(defaultMessage('TSLA', sma)).toBe('TSLA SMA (50) 穿越 收盘价');
  });

  it('uses the user message when there is one', () => {
    expect(messageOf({ symbol: 'AAPL', condition: price, message: 'buy' })).toBe('buy');
    expect(messageOf({ symbol: 'AAPL', condition: price, message: '' })).toBe('AAPL crossing 190.00');
  });

  it('summarizes with arrows', () => {
    expect(summaryOf(price)).toBe('↕ 190.00');
    expect(summaryOf(rsi)).toBe('RSI (14) ↑ 70');
    expect(summaryOf(macd)).toBe('MACD (12, 26, 9) MACD ↓ Signal');
  });

  it('shows the check interval in seconds or minutes', () => {
    expect(intervalText(30)).toBe('Checked every 30 s');
    expect(intervalText(400)).toBe('Checked every 7 min');
  });
});

describe('matchesSearch', () => {
  it('matches the symbol and the indicator, ignoring case', () => {
    expect(matchesSearch({ symbol: 'AAPL', condition: price }, 'aap')).toBe(true);
    expect(matchesSearch({ symbol: 'AAPL', condition: price }, 'rsi')).toBe(false);
    expect(matchesSearch({ symbol: 'NVDA', condition: rsi }, 'rsi')).toBe(true);
    expect(matchesSearch({ symbol: 'MSFT', condition: macd }, 'Signal')).toBe(false);
    expect(matchesSearch({ symbol: 'MSFT', condition: macd }, 'macd')).toBe(true);
    expect(matchesSearch({ symbol: 'MSFT', condition: macd }, '  ')).toBe(true);
  });
});

describe('order', () => {
  const alert = (id: string, symbol: string, status: Alert['status'], createdAt = 1): Alert => ({
    id, symbol, condition: price, frequency: 'once', expiry: '1M', expiresAt: 9, message: '', status, revision: 1, createdAt, updatedAt: 1,
    state: { lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null },
  });
  it('sorts alerts: active first, then by symbol', () => {
    const list = [alert('1', 'MSFT', 'expired'), alert('2', 'TSLA', 'active'), alert('3', 'AAPL', 'paused'), alert('4', 'AAPL', 'active')];
    expect(sortAlerts(list).map((a) => a.id)).toEqual(['4', '2', '3', '1']);
  });
  it('sorts events: unchecked first, then newest first', () => {
    const ev = (id: string, firedAt: number, checked: boolean) => ({ id, firedAt, checked }) as AlertEvent;
    expect(sortEvents([ev('a', 1, false), ev('b', 3, true), ev('c', 2, false)]).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
});
