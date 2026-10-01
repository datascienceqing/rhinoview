import type { Bar } from '@shared/types';
import { classifyUpdate, findBarIndexByTime, toCandles, toCloseLine } from './convert';

const bar = (time: number, close = 100): Bar => ({
  time,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 10,
  vwap: null,
  transactions: null,
});
const bars = (...times: number[]) => times.map((t) => bar(t));

describe('classifyUpdate', () => {
  it('treats the same array as no change', () => {
    const b = bars(1, 2, 3);
    expect(classifyUpdate(b, b)).toEqual({ kind: 'same' });
  });

  it('recognises older bars arriving as a prepend, with the count added', () => {
    expect(classifyUpdate(bars(3, 4, 5), bars(1, 2, 3, 4, 5))).toEqual({ kind: 'prepend', added: 2 });
  });

  it('treats a different series (new timeframe) as a replace', () => {
    expect(classifyUpdate(bars(3, 4, 5), bars(10, 20, 30, 40))).toEqual({ kind: 'replace' });
  });

  it('treats growth at the right edge as a replace, not a prepend', () => {
    expect(classifyUpdate(bars(1, 2, 3), bars(1, 2, 3, 4))).toEqual({ kind: 'replace' });
  });

  it('treats going from or to empty as a replace', () => {
    expect(classifyUpdate([], bars(1, 2))).toEqual({ kind: 'replace' });
    expect(classifyUpdate(bars(1, 2), [])).toEqual({ kind: 'replace' });
  });
});

describe('findBarIndexByTime', () => {
  it('finds exact times and returns -1 for gaps', () => {
    const b = bars(10, 20, 30, 40);
    expect(findBarIndexByTime(b, 30)).toBe(2);
    expect(findBarIndexByTime(b, 25)).toBe(-1);
    expect(findBarIndexByTime([], 1)).toBe(-1);
  });
});

describe('series data conversion', () => {
  it('passes Bar.time through untouched: seconds in, the same seconds out', () => {
    const b = [bar(1790775000, 218.5)];
    expect(toCandles(b)[0]?.time).toBe(1790775000);
    expect(toCloseLine(b)[0]).toEqual({ time: 1790775000, value: 218.5 });
  });
});
