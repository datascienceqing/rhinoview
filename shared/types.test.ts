import { describe, it, expect } from 'vitest';
import { TIMEFRAMES, isIntraday, INDICATOR_PLACEMENT, type Timeframe } from './types';

describe('timeframes', () => {
  it('classifies every timeframe as intraday or not', () => {
    const intraday = TIMEFRAMES.filter(isIntraday);
    const daily = TIMEFRAMES.filter((tf) => !isIntraday(tf));
    expect(intraday).toEqual<Timeframe[]>(['1m', '5m', '15m', '1h', '4h']);
    expect(daily).toEqual<Timeframe[]>(['1D', '1W']);
  });
});

describe('indicator placement', () => {
  it('puts moving averages on price and oscillators in their own pane', () => {
    expect(INDICATOR_PLACEMENT.sma).toBe('overlay');
    expect(INDICATOR_PLACEMENT.ema).toBe('overlay');
    expect(INDICATOR_PLACEMENT.rsi).toBe('separate');
    expect(INDICATOR_PLACEMENT.macd).toBe('separate');
  });
});
