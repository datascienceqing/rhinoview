import { toHistogramData, toLineData } from './convert';

describe('toLineData', () => {
  it('turns null warmup into whitespace (no value), never into 0', () => {
    const data = toLineData([
      { time: 1, value: null },
      { time: 2, value: null },
      { time: 3, value: 5 },
    ]);
    expect(data).toEqual([{ time: 1 }, { time: 2 }, { time: 3, value: 5 }]);
    for (const d of data.slice(0, 2)) expect('value' in d).toBe(false);
  });

  it('keeps a genuine zero as a zero', () => {
    expect(toLineData([{ time: 1, value: 0 }])).toEqual([{ time: 1, value: 0 }]);
  });

  it('treats NaN and Infinity as gaps too', () => {
    expect(toLineData([{ time: 1, value: Number.NaN }, { time: 2, value: Infinity }])).toEqual([{ time: 1 }, { time: 2 }]);
  });

  it('passes times through untouched (Unix seconds in, seconds out)', () => {
    expect(toLineData([{ time: 1790775000, value: 1 }]).map((d) => d.time)).toEqual([1790775000]);
  });
});

describe('toHistogramData', () => {
  it('colours by sign, with zero counted as non-negative, and leaves warmup as whitespace', () => {
    const data = toHistogramData(
      [
        { time: 1, value: null },
        { time: 2, value: 0.5 },
        { time: 3, value: -0.5 },
        { time: 4, value: 0 },
      ],
      'UP',
      'DOWN',
    );
    expect(data).toEqual([
      { time: 1 },
      { time: 2, value: 0.5, color: 'UP' },
      { time: 3, value: -0.5, color: 'DOWN' },
      { time: 4, value: 0, color: 'UP' },
    ]);
  });
});
