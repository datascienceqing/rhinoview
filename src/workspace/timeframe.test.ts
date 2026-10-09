import type { Timeframe } from '@shared/types';
import { effectiveTimeframe } from './timeframe';

const caps = (timeframes: Timeframe[]) => ({ timeframes });

describe('effectiveTimeframe', () => {
  it('keeps a supported timeframe', () => {
    expect(effectiveTimeframe('15m', caps(['5m', '15m', '1D']))).toBe('15m');
  });

  it('keeps everything while capabilities are unknown', () => {
    expect(effectiveTimeframe('1m', null)).toBe('1m');
  });

  it('takes the next coarser supported timeframe', () => {
    expect(effectiveTimeframe('1m', caps(['5m', '15m', '1h', '1D', '1W']))).toBe('5m');
    expect(effectiveTimeframe('1m', caps(['1h', '1D']))).toBe('1h');
  });

  it('prefers coarser over finer at equal distance', () => {
    expect(effectiveTimeframe('15m', caps(['5m', '1h']))).toBe('1h'); // 5m and 1h are both one step away
  });

  it('takes a nearer finer timeframe over a farther coarser one', () => {
    expect(effectiveTimeframe('1h', caps(['15m', '1W']))).toBe('15m');
  });

  it('falls back to a finer timeframe when nothing coarser exists', () => {
    expect(effectiveTimeframe('1W', caps(['5m', '15m']))).toBe('15m');
  });

  it('changes nothing when the provider lists no timeframes', () => {
    expect(effectiveTimeframe('1m', caps([]))).toBe('1m');
  });
});
