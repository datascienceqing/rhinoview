import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { aggregateWeekly, eodRowsToBars, intradayRowsToBars, snapshotFromQuote, wholeShares } from './convert';
import { eodResponseSchema, quoteResponseSchema } from './schemas';
import { fixtureRows } from './testing';
import { dateToNySeconds } from './time';

const iso = (t: number) => new Date(t * 1000).toISOString();
const row = (date: string, o: number, h: number, l: number, c: number, volume: number, vwap: number | null = null) =>
  ({ date, open: o, high: h, low: l, close: c, volume, vwap });

describe('dateToNySeconds', () => {
  it('stamps a summer date at 00:00 EDT (04:00Z)', () => {
    expect(iso(dateToNySeconds('2025-10-31') ?? NaN)).toBe('2025-10-31T04:00:00.000Z');
  });

  it('stamps a winter date at 00:00 EST (05:00Z)', () => {
    expect(iso(dateToNySeconds('2025-11-03') ?? NaN)).toBe('2025-11-03T05:00:00.000Z');
  });

  it('follows the fall-back DST change between Fri 31 Oct and Mon 3 Nov 2025 (3 days + 1 hour apart)', () => {
    const fri = dateToNySeconds('2025-10-31') ?? NaN;
    const mon = dateToNySeconds('2025-11-03') ?? NaN;
    expect(mon - fri).toBe(3 * 86400 + 3600);
  });

  it('follows the spring-forward change between Fri 7 Mar and Mon 10 Mar 2025 (3 days - 1 hour apart)', () => {
    const fri = dateToNySeconds('2025-03-07') ?? NaN;
    const mon = dateToNySeconds('2025-03-10') ?? NaN;
    expect(iso(fri)).toBe('2025-03-07T05:00:00.000Z');
    expect(iso(mon)).toBe('2025-03-10T04:00:00.000Z');
    expect(mon - fri).toBe(3 * 86400 - 3600);
  });

  it.each(['', 'garbage', '2025-13-01', '2025-02-30', '2025-1-5', '20251105', '2025-11-05T00:00:00Z'])(
    'rejects %j instead of inventing a time',
    (bad) => {
      expect(dateToNySeconds(bad)).toBeUndefined();
    },
  );
});

describe('eodRowsToBars', () => {
  const fixture = eodResponseSchema.parse(fixtureRows('eod-aapl-dst'));

  it('the recorded FMP response really is newest-first (the premise of the reversal)', () => {
    expect(fixture[0]?.date).toBe('2025-11-07');
    expect(fixture.at(-1)?.date).toBe('2025-10-27');
  });

  it('returns ascending, strictly increasing bars from a descending response', () => {
    const bars = eodRowsToBars(fixture);
    expect(bars).toHaveLength(10);
    for (let i = 1; i < bars.length; i++) expect(bars[i]?.time).toBeGreaterThan(bars[i - 1]?.time ?? Infinity);
    expect(iso(bars[0]?.time ?? NaN)).toBe('2025-10-27T04:00:00.000Z');
    expect(iso(bars.at(-1)?.time ?? NaN)).toBe('2025-11-07T05:00:00.000Z');
  });

  it('is indifferent to input order and de-duplicates a repeated date, keeping the later row', () => {
    const rows = [row('2025-11-05', 1, 2, 1, 2, 10), row('2025-11-04', 1, 2, 1, 1, 10), row('2025-11-05', 9, 9, 9, 9, 99)];
    const bars = eodRowsToBars(rows);
    expect(bars.map((b) => b.open)).toEqual([1, 9]);
  });

  it('maps fields one-to-one and never fabricates transactions', () => {
    const bar = eodRowsToBars(fixture).at(-1);
    expect(bar).toEqual({
      time: dateToNySeconds('2025-11-07'),
      open: 269.8,
      high: 272.29,
      low: 266.77,
      close: 268.47,
      volume: 48227400,
      vwap: 269.3325,
      transactions: null,
    });
  });

  it('keeps a missing vwap as null, never 0', () => {
    const [bar] = eodRowsToBars(eodResponseSchema.parse([{ date: '2025-11-05', open: 1, high: 2, low: 1, close: 2, volume: 5 }]));
    expect(bar?.vwap).toBeNull();
  });

  it('drops a row whose date cannot be turned into a time', () => {
    expect(eodRowsToBars([row('2025-02-30', 1, 2, 1, 2, 3), row('2025-02-28', 1, 2, 1, 2, 3)])).toHaveLength(1);
  });
});

describe('aggregateWeekly', () => {
  const daily = eodRowsToBars(eodResponseSchema.parse(fixtureRows('eod-aapl-dst')));
  const weeks = aggregateWeekly(daily);

  // Expected values were summed by hand from the recorded rows (see the fixture), not
  // computed by the code under test.
  it('stamps each week on its New York Monday, across the DST change', () => {
    expect(weeks.map((w) => iso(w.time))).toEqual(['2025-10-27T04:00:00.000Z', '2025-11-03T05:00:00.000Z']);
  });

  it('week 1 (27-31 Oct): open from Monday, close from Friday, extremes and volume summed', () => {
    expect(weeks[0]).toMatchObject({ open: 264.88, high: 277.32, low: 264.65, close: 270.37, volume: 293563399, transactions: null });
  });

  it('week 2 (3-7 Nov): open from Monday, close from Friday, extremes and volume summed', () => {
    expect(weeks[1]).toMatchObject({ open: 270.42, high: 273.4, low: 266.25, close: 268.47, volume: 242583991 });
  });

  it('weekly volume equals the sum of its daily volumes', () => {
    const total = daily.reduce((s, d) => s + d.volume, 0);
    expect(weeks.reduce((s, w) => s + w.volume, 0)).toBe(total);
  });

  it('vwap is volume-weighted over the days, not a plain mean', () => {
    const week1 = daily.slice(0, 5);
    const expected = week1.reduce((s, d) => s + (d.vwap ?? 0) * d.volume, 0) / week1.reduce((s, d) => s + d.volume, 0);
    expect(weeks[0]?.vwap).toBeCloseTo(expected, 4);
  });

  it('vwap is null when any day lacks one', () => {
    const days: Bar[] = daily.slice(0, 5).map((d, i) => (i === 2 ? { ...d, vwap: null } : d));
    expect(aggregateWeekly(days)[0]?.vwap).toBeNull();
  });

  it('stamps a short week on its Monday even when Monday is a holiday (Labor Day 2025-09-01)', () => {
    const rows = [
      row('2025-09-02', 10, 12, 9, 11, 100),
      row('2025-09-03', 11, 15, 10, 14, 200),
      row('2025-09-05', 14, 14, 8, 9, 300),
      row('2025-09-08', 9, 9, 9, 9, 1),
    ];
    const out = aggregateWeekly(eodRowsToBars(rows));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ time: dateToNySeconds('2025-09-01'), open: 10, high: 15, low: 8, close: 9, volume: 600 });
    expect(out[1]?.time).toBe(dateToNySeconds('2025-09-08'));
  });

  it('returns nothing for no input', () => {
    expect(aggregateWeekly([])).toEqual([]);
  });
});

describe('snapshotFromQuote', () => {
  const quote = quoteResponseSchema.parse(fixtureRows('quote-aapl'))[0];
  if (!quote) throw new Error('fixture has no row');

  it('divides FMP changePercentage (a percentage) by 100 to get our fraction', () => {
    expect(quote.changePercentage).toBe(1.02022);
    const snap = snapshotFromQuote(quote, true);
    expect(snap.changePercent).toBeCloseTo(0.0102022, 10);
    // A 100x error would put this at ~1.02, i.e. "+102%" in the header.
    expect(Math.abs(snap.changePercent ?? 99)).toBeLessThan(0.1);
  });

  it('agrees with change / previousClose, the independent definition of the same number', () => {
    const snap = snapshotFromQuote(quote, true);
    expect(snap.changePercent).toBeCloseTo((snap.change ?? NaN) / (snap.previousClose ?? NaN), 4);
  });

  it('maps the other fields and takes the timestamp as seconds, unconverted', () => {
    expect(snapshotFromQuote(quote, false)).toEqual({
      symbol: 'AAPL',
      price: 333.69,
      change: 3.37,
      changePercent: quote.changePercentage === null ? null : quote.changePercentage / 100,
      previousClose: 330.32,
      dayOpen: 333.205,
      dayHigh: 334.54,
      dayLow: 330.61,
      dayVolume: 31878433,
      updated: 1790971201,
      delayed: false,
    });
  });

  it('carries the delayed flag it is given', () => {
    expect(snapshotFromQuote(quote, true).delayed).toBe(true);
  });

  it('leaves absent fields null, not 0', () => {
    const sparse = quoteResponseSchema.parse([{ symbol: 'aapl' }])[0];
    if (!sparse) throw new Error('unreachable');
    const snap = snapshotFromQuote(sparse, true);
    expect(snap).toMatchObject({ symbol: 'AAPL', price: null, changePercent: null, updated: null });
  });
});

describe('volume is whole shares', () => {
  // Values measured from FMP on 2026-10-09 (AAPL 5min and 1hour).
  it('rounds the fractional intraday volume FMP sends', () => {
    const bars = intradayRowsToBars([
      { date: '2026-10-08 15:45:00', open: 1, high: 2, low: 1, close: 2, volume: 320128.0681499988 },
      { date: '2026-10-08 15:50:00', open: 1, high: 2, low: 1, close: 2, volume: 584047 },
      { date: '2026-08-14 09:30:00', open: 1, high: 2, low: 1, close: 2, volume: 5125954.5 },
    ]);
    expect(bars.map((b) => b.volume)).toEqual([5125955, 320128, 584047]);
  });

  it('rounds daily volume too', () => {
    expect(eodRowsToBars([row('2026-10-08', 1, 2, 1, 2, 1000.4)])[0]?.volume).toBe(1000);
  });

  it('rounds the quote day volume, and keeps an absent one null', () => {
    const [q] = quoteResponseSchema.parse([{ symbol: 'AAPL', volume: 34459897.6 }]);
    if (!q) throw new Error('unreachable');
    expect(snapshotFromQuote(q, true).dayVolume).toBe(34459898);
    const [none] = quoteResponseSchema.parse([{ symbol: 'AAPL' }]);
    if (!none) throw new Error('unreachable');
    expect(snapshotFromQuote(none, true).dayVolume).toBeNull();
  });

  it('leaves a whole number as it is', () => {
    expect(wholeShares(7_720_000)).toBe(7_720_000);
    expect(wholeShares(0)).toBe(0);
  });
});
