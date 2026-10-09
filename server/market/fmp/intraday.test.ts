import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@shared/types';
import { UpstreamUnauthorizedError, mapEngineError } from '../../provider/errors';
import { FmpPaymentRequiredError } from './client';
import { createFmpEngine } from './index';
import { TEST_KEY, fakeFetch, responseOf } from './testing';
import type { FakeFetch } from './testing';
import { dateTimeToNySeconds, dateToNySeconds } from './time';

const phase5 = (name: string): { status: number; body: unknown } =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/phase5/${name}.json`, import.meta.url)), 'utf8')) as { status: number; body: unknown };

/** Serve a Phase 5 fixture the way the real endpoint would: JSON text for 200, plain text for 402. */
const serve = (name: string) => {
  const f = phase5(name);
  return responseOf({ status: f.status, body: typeof f.body === 'string' ? f.body : JSON.stringify(f.body) });
};
const engineWith = (fetch: FakeFetch) => createFmpEngine({ apiKey: TEST_KEY, fetch, sleep: () => Promise.resolve() });
const NY = (date: string) => dateToNySeconds(date) ?? NaN;
const at = (wall: string) => dateTimeToNySeconds(wall) ?? NaN;

const ask = (e: ReturnType<typeof engineWith>, timeframe: Timeframe, from: number, to: number, limit = 10_000) =>
  e.getBars({ symbol: 'AAPL', timeframe, from, to, adjusted: true, limit });

describe('dateTimeToNySeconds', () => {
  it('reads the string as New York wall clock, not UTC (EDT: 09:30 is 13:30Z)', () => {
    expect(at('2026-10-01 09:30:00')).toBe(Date.UTC(2026, 9, 1, 13, 30) / 1000);
  });

  it('follows DST: the same wall time is 14:30Z in EST and 13:30Z in EDT', () => {
    // US spring-forward 2026 is Sunday 8 March: Friday 6th is EST, Monday 9th is EDT.
    expect(at('2026-03-06 09:30:00')).toBe(Date.UTC(2026, 2, 6, 14, 30) / 1000);
    expect(at('2026-03-09 09:30:00')).toBe(Date.UTC(2026, 2, 9, 13, 30) / 1000);
    // Fall-back 2026 is Sunday 1 November.
    expect(at('2026-10-30 15:55:00')).toBe(Date.UTC(2026, 9, 30, 19, 55) / 1000);
    expect(at('2026-11-02 15:55:00')).toBe(Date.UTC(2026, 10, 2, 20, 55) / 1000);
  });

  it('rejects malformed strings', () => {
    for (const bad of ['2026-10-01', '2026-10-01 25:00:00', '2026-02-30 10:00:00', 'nope']) expect(dateTimeToNySeconds(bad)).toBeUndefined();
  });
});

describe('getBars intraday', () => {
  it('returns ascending bars stamped at the bar open in New York time from a newest-first response', async () => {
    const fetch = fakeFetch(() => serve('chart-5min-AAPL-2026-09-30_10-01'));
    const { bars, truncated } = await ask(engineWith(fetch), '5m', NY('2026-09-30'), at('2026-10-01 16:00:00'));
    expect(bars).toHaveLength(156);
    expect(truncated).toBe(false);
    for (let i = 1; i < bars.length; i++) expect(bars[i]?.time).toBeGreaterThan(bars[i - 1]?.time ?? Infinity);
    expect(bars[0]?.time).toBe(at('2026-09-30 09:30:00'));
    expect(bars.at(-1)?.time).toBe(at('2026-10-01 15:55:00'));
    // 09:30 EDT is 13:30Z: a UTC reading would be four hours off.
    expect(bars[0]?.time).toBe(Date.UTC(2026, 8, 30, 13, 30) / 1000);
    expect(bars[0]).toMatchObject({ vwap: null, transactions: null });
  });

  it.each([
    ['5m', '5min', 'chart-5min-AAPL-2026-09-30_10-01'],
    ['15m', '15min', 'chart-15min-AAPL-2026-09-30_10-01'],
    ['1h', '1hour', 'chart-1hour-AAPL-2026-09-30_10-01'],
  ] as const)('%s asks /historical-chart/%s with NY civil dates', async (tf, path, fixture) => {
    const fetch = fakeFetch(() => serve(fixture));
    await ask(engineWith(fetch), tf, at('2026-09-30 09:30:00'), at('2026-10-01 16:00:00'));
    const url = fetch.calls[0];
    expect(url?.pathname.endsWith(`/historical-chart/${path}`)).toBe(true);
    expect([url?.searchParams.get('symbol'), url?.searchParams.get('from'), url?.searchParams.get('to')]).toEqual(['AAPL', '2026-09-30', '2026-10-01']);
  });

  it('keeps hourly bars session-aligned (09:30 ... 15:30)', async () => {
    const { bars } = await ask(engineWith(fakeFetch(() => serve('chart-1hour-AAPL-2026-09-30_10-01'))), '1h', NY('2026-09-30'), at('2026-10-01 16:00:00'));
    expect(bars).toHaveLength(14);
    const offsets = bars.slice(0, 7).map((b) => b.time - NY('2026-09-30'));
    expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6].map((k) => 9.5 * 3600 + k * 3600));
  });

  it('filters to the requested range, inclusive on bar time', async () => {
    const from = at('2026-10-01 10:00:00');
    const to = at('2026-10-01 10:10:00');
    const { bars } = await ask(engineWith(fakeFetch(() => serve('chart-5min-AAPL-2026-09-30_10-01'))), '5m', from, to);
    expect(bars.map((b) => b.time)).toEqual([from, from + 300, from + 600]);
  });

  it('keeps the newest `limit` bars and reports truncated', async () => {
    const e = engineWith(fakeFetch(() => serve('chart-5min-AAPL-2026-09-30_10-01')));
    const { bars, truncated } = await ask(e, '5m', NY('2026-09-30'), at('2026-10-01 16:00:00'), 10);
    expect(bars).toHaveLength(10);
    expect(truncated).toBe(true);
    expect(bars.at(-1)?.time).toBe(at('2026-10-01 15:55:00'));
  });

  describe('truncated rule: a session ending after `from` has no data before the oldest bar', () => {
    it('is true for the 624-row page when `from` reaches further back', async () => {
      const e = engineWith(fakeFetch(() => serve('chart-5min-AAPL-2025-06-02_06-13')));
      const { bars, truncated } = await ask(e, '5m', NY('2025-06-02'), at('2025-06-13 16:00:00'));
      expect(bars).toHaveLength(624);
      expect(bars[0]?.time).toBe(at('2025-06-04 09:30:00'));
      expect(truncated).toBe(true);
    });

    it('is false when the oldest bar is on the first session of the range', async () => {
      const e = engineWith(fakeFetch(() => serve('chart-5min-AAPL-2026-09-30_10-01')));
      expect((await ask(e, '5m', NY('2026-09-30'), at('2026-10-01 16:00:00'))).truncated).toBe(false);
    });

    const oneRow = (date: string) => engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify([{ date, open: 1, high: 2, low: 1, close: 2, volume: 5 }]) })));

    it('is true when exactly ONE whole session is missing before the oldest bar', async () => {
      // Mon 5th has no rows although it is a session after `from`; the oldest bar is Tue 6th.
      expect((await ask(oneRow('2026-10-06 09:30:00'), '5m', NY('2026-10-05'), at('2026-10-06 16:00:00'))).truncated).toBe(true);
    });

    it('is false when `from` is after the missing session closed (Monday 20:00 NY does not flag Monday)', async () => {
      expect((await ask(oneRow('2026-10-06 09:30:00'), '5m', at('2026-10-05 20:00:00'), at('2026-10-06 16:00:00'))).truncated).toBe(false);
    });

    it('is true when `from` is inside the missing session, before its close', async () => {
      expect((await ask(oneRow('2026-10-06 09:30:00'), '5m', at('2026-10-05 15:00:00'), at('2026-10-06 16:00:00'))).truncated).toBe(true);
    });

    it('is false when `from` is a weekend and the oldest bar is the next Monday (no session was skipped)', async () => {
      expect((await ask(oneRow('2026-10-05 09:30:00'), '5m', NY('2026-10-03'), at('2026-10-05 16:00:00'))).truncated).toBe(false);
    });

    it('is false when the only earlier day is a holiday (Columbus Day is a trading day; Thanksgiving is not)', async () => {
      // Thu 2026-11-26 is Thanksgiving: closed. Oldest bar is Fri 27th (early close day).
      expect((await ask(oneRow('2026-11-27 09:30:00'), '5m', NY('2026-11-26'), at('2026-11-27 13:00:00'))).truncated).toBe(false);
    });

    it('is false across a weekend plus the weekday before it closed before `from`', async () => {
      // Friday 20:00 NY -> next bar Monday: Friday already closed, weekend has no session.
      expect((await ask(oneRow('2026-10-05 09:30:00'), '5m', at('2026-10-02 20:00:00'), at('2026-10-05 16:00:00'))).truncated).toBe(false);
    });

    it('uses the early-close time: from after a 13:00 close does not flag that day', async () => {
      // Fri 2026-11-27 closes at 13:00; from = 13:30 same day, oldest bar Mon 30th.
      expect((await ask(oneRow('2026-11-30 09:30:00'), '5m', at('2026-11-27 13:30:00'), at('2026-11-30 16:00:00'))).truncated).toBe(false);
      expect((await ask(oneRow('2026-11-30 09:30:00'), '5m', at('2026-11-27 12:30:00'), at('2026-11-30 16:00:00'))).truncated).toBe(true);
    });

    describe('clipped inside the oldest bar\'s day', () => {
      const row = (date: string) => ({ date, open: 1, high: 2, low: 1, close: 2, volume: 5 });
      const serveRows = (dates: string[]) => engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify(dates.map(row)) })));

      it('is true when from is the previous day and the day\'s morning bars are missing', async () => {
        const e = serveRows(['2026-10-06 11:00:00', '2026-10-06 11:05:00']);
        expect((await ask(e, '5m', at('2026-10-05 20:00:00'), at('2026-10-06 16:00:00'))).truncated).toBe(true);
      });

      it('is true when from is the same day before the open and the first bar is missing', async () => {
        const e = serveRows(['2026-10-06 09:35:00', '2026-10-06 09:40:00']);
        expect((await ask(e, '5m', at('2026-10-06 08:00:00'), at('2026-10-06 16:00:00'))).truncated).toBe(true);
      });

      it('is false when from is mid-session and the oldest bar is the first bar after from', async () => {
        const e = serveRows(['2026-10-06 10:05:00', '2026-10-06 10:10:00']);
        expect((await ask(e, '5m', at('2026-10-06 10:02:00'), at('2026-10-06 16:00:00'))).truncated).toBe(false);
      });

      it('is true when from is mid-session and bars after it are missing', async () => {
        const e = serveRows(['2026-10-06 11:00:00']);
        expect((await ask(e, '5m', at('2026-10-06 10:02:00'), at('2026-10-06 16:00:00'))).truncated).toBe(true);
      });

      it('is false for a full day starting at 09:30', async () => {
        const e = serveRows(['2026-10-06 09:30:00', '2026-10-06 09:35:00']);
        expect((await ask(e, '5m', at('2026-10-05 20:00:00'), at('2026-10-06 16:00:00'))).truncated).toBe(false);
      });

      it('is false for 1h bars starting at 09:30, and true when the 09:30 hour is missing', async () => {
        const from = at('2026-10-05 20:00:00');
        const to = at('2026-10-06 16:00:00');
        expect((await ask(serveRows(['2026-10-06 09:30:00', '2026-10-06 10:30:00']), '1h', from, to)).truncated).toBe(false);
        expect((await ask(serveRows(['2026-10-06 10:30:00']), '1h', from, to)).truncated).toBe(true);
      });

      it('15m: a first bar at 09:45 is a gap, 09:30 is not', async () => {
        const from = at('2026-10-05 20:00:00');
        const to = at('2026-10-06 16:00:00');
        expect((await ask(serveRows(['2026-10-06 09:30:00']), '15m', from, to)).truncated).toBe(false);
        expect((await ask(serveRows(['2026-10-06 09:45:00']), '15m', from, to)).truncated).toBe(true);
      });
    });

    it('is false for an empty answer', async () => {
      const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: '[]' })));
      expect(await ask(e, '5m', NY('2026-10-05'), at('2026-10-07 16:00:00'))).toEqual({ bars: [], truncated: false });
    });
  });

  it('keeps 5m bars and 1h bars consistent: hourly volume is the sum of its twelve 5m bars', async () => {
    const f5 = engineWith(fakeFetch(() => serve('chart-5min-AAPL-2026-09-30_10-01')));
    const f1 = engineWith(fakeFetch(() => serve('chart-1hour-AAPL-2026-09-30_10-01')));
    const range = [NY('2026-09-30'), at('2026-10-01 16:00:00')] as const;
    const five = (await ask(f5, '5m', ...range)).bars;
    const hour = (await ask(f1, '1h', ...range)).bars[0];
    const sum = five.filter((b) => b.time >= (hour?.time ?? 0) && b.time < (hour?.time ?? 0) + 3600).reduce((a, b) => a + b.volume, 0);
    expect(hour?.volume).toBe(sum);
  });
});

describe('unavailable intraday', () => {
  it('1m is refused as UNAUTHORIZED without calling upstream', async () => {
    const fetch = fakeFetch(() => serve('chart-1min-AAPL-GATED'));
    const err = await ask(engineWith(fetch), '1m', 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnauthorizedError);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
    expect(fetch.calls).toHaveLength(0);
  });

  it('the recorded 1min 402 body surfaces as UNAUTHORIZED if upstream ever answers it', async () => {
    const e = engineWith(fakeFetch(() => serve('chart-1min-AAPL-GATED')));
    const err = await ask(e, '5m', NY('2026-09-30'), at('2026-10-01 16:00:00')).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(FmpPaymentRequiredError);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });
});
