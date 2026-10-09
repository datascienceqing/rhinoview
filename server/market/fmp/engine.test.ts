import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UnknownSymbolError } from '../types';
import { UnsupportedRequestError, UpstreamUnauthorizedError, mapEngineError } from '../../provider/errors';
import { civilToDay, weekdayOf } from '../calendar';
import { FmpPaymentRequiredError } from './client';
import { createFmpEngine } from './index';
import { TEST_KEY, fakeFetch, responseOf, routedFetch } from './testing';
import type { FakeFetch } from './testing';
import { dateToNySeconds, dayNumberToDate } from './time';

const T = (date: string) => dateToNySeconds(date) ?? NaN;
const noSleep = () => Promise.resolve();

function engineWith(fetch: FakeFetch, extra: Partial<Parameters<typeof createFmpEngine>[0]> = {}) {
  return createFmpEngine({ apiKey: TEST_KEY, fetch, sleep: noSleep, ...extra });
}

/** `count` weekday rows, newest first, ending on `lastDate`. Shape of a real FMP response; values synthetic. */
function descendingRows(count: number, lastDate: string) {
  const rows: Record<string, unknown>[] = [];
  let day = civilToDay(Number(lastDate.slice(0, 4)), Number(lastDate.slice(5, 7)), Number(lastDate.slice(8, 10)));
  while (rows.length < count) {
    if (weekdayOf(day) <= 4) {
      const n = rows.length;
      rows.push({ symbol: 'AAPL', date: dayNumberToDate(day), open: 100 + n, high: 102 + n, low: 99 + n, close: 101 + n, volume: 1000 + n, vwap: 100.5 + n });
    }
    day--;
  }
  return rows;
}

const eodFixtureFetch = () => routedFetch({ '/historical-price-eod/full': 'eod-aapl-dst' });
const bars = (e: ReturnType<typeof engineWith>, timeframe: '1D' | '1W', from: string, to: string, extra = {}) =>
  e.getBars({ symbol: 'AAPL', timeframe, from: T(from), to: T(to), adjusted: true, limit: 2000, ...extra });

describe('capabilities', () => {
  it('serves 5m, 15m, 1h, 1D and 1W, but not 1m: what Starter can actually fetch', () => {
    expect(engineWith(fakeFetch(() => responseOf({ status: 200, body: '[]' }))).supportedTimeframes).toEqual(['5m', '15m', '1h', '1D', '1W']);
  });
});

describe('getBars 1D', () => {
  it('returns ascending bars from the descending upstream response, stamped at NY midnight', async () => {
    const fetch = eodFixtureFetch();
    const { bars: out, truncated } = await bars(engineWith(fetch), '1D', '2025-10-27', '2025-11-07');
    expect(truncated).toBe(false);
    expect(out).toHaveLength(10);
    expect(out.map((b) => b.time)).toEqual([...out.map((b) => b.time)].sort((a, b) => a - b));
    expect(out[0]?.time).toBe(T('2025-10-27'));
    expect(out.at(-1)?.time).toBe(T('2025-11-07'));
  });

  it('asks upstream for NY civil dates, not UTC ones', async () => {
    const fetch = eodFixtureFetch();
    // 2025-11-07 00:00 EST is 05:00Z; a UTC-based conversion of `to` in the evening would roll to the 8th.
    await bars(engineWith(fetch), '1D', '2025-10-27', '2025-11-07');
    const q = fetch.calls[0]?.searchParams;
    expect([q?.get('symbol'), q?.get('from'), q?.get('to')]).toEqual(['AAPL', '2025-10-27', '2025-11-07']);
  });

  it('range filtering is inclusive on bar time at both ends', async () => {
    const e = engineWith(eodFixtureFetch());
    const { bars: out } = await bars(e, '1D', '2025-10-29', '2025-11-04');
    expect(out.map((b) => b.time)).toEqual(['2025-10-29', '2025-10-30', '2025-10-31', '2025-11-03', '2025-11-04'].map(T));
  });

  it('a valid range with no sessions is an empty, non-truncated answer', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: '[]' })));
    expect(await bars(e, '1D', '2025-10-25', '2025-10-26')).toEqual({ bars: [], truncated: false });
  });

  it('to before from is empty without calling upstream', async () => {
    const fetch = fakeFetch(() => responseOf({ status: 200, body: '[]' }));
    expect(await bars(engineWith(fetch), '1D', '2025-11-07', '2025-10-27')).toEqual({ bars: [], truncated: false });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('the 5,000-row upstream cap', () => {
  const capped = () =>
    engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify(descendingRows(5000, '2026-10-02')) })));

  it('the real capped response was newest-first with exactly 5000 rows (recorded shape)', () => {
    const summary = JSON.parse(readFileSync(fileURLToPath(new URL('./__fixtures__/eod-aapl-capped.summary.json', import.meta.url)), 'utf8')) as {
      rowCount: number;
      descending: boolean;
      newest: { date: string };
      oldest: { date: string };
    };
    expect(summary).toMatchObject({ rowCount: 5000, descending: true, newest: { date: '2026-10-02' }, oldest: { date: '2006-11-15' } });
  });

  it('sets truncated and keeps the NEWEST bars, so the oldest returned bar is the partial edge', async () => {
    const { bars: out, truncated } = await capped().getBars({
      symbol: 'AAPL',
      timeframe: '1D',
      from: 0,
      to: T('2026-10-02'),
      adjusted: true,
      limit: 10_000,
    });
    expect(truncated).toBe(true);
    expect(out).toHaveLength(5000);
    expect(out.at(-1)?.time).toBe(T('2026-10-02'));
    // The range asked for everything since the epoch; the oldest bar kept is far later, which is what `truncated` tells the client.
    expect(out[0]?.time).toBeGreaterThan(T('2006-01-01'));
  });

  it('an under-cap response is not truncated', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify(descendingRows(4999, '2026-10-02')) })));
    expect((await e.getBars({ symbol: 'AAPL', timeframe: '1D', from: 0, to: T('2026-10-02'), adjusted: true, limit: 10_000 })).truncated).toBe(false);
  });

  it('the caller limit clips the OLD end and sets truncated', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify(descendingRows(300, '2026-10-02')) })));
    const { bars: out, truncated } = await e.getBars({ symbol: 'AAPL', timeframe: '1D', from: 0, to: T('2026-10-02'), adjusted: true, limit: 50 });
    expect(truncated).toBe(true);
    expect(out).toHaveLength(50);
    expect(out.at(-1)?.time).toBe(T('2026-10-02'));
  });

  it('weekly on a capped response drops the oldest, mid-week-cut week and flags truncated', async () => {
    // 5000 weekdays ending Thu 2026-10-01: the oldest row is a lone Friday, so the oldest
    // week is partial. 1 partial + 999 whole + the current Mon-Thu week = 1001 buckets; the partial one is dropped.
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: JSON.stringify(descendingRows(5000, '2026-10-01')) })));
    const { bars: out, truncated } = await e.getBars({ symbol: 'AAPL', timeframe: '1W', from: 0, to: T('2026-10-02'), adjusted: true, limit: 10_000 });
    expect(truncated).toBe(true);
    expect(out).toHaveLength(1000);
    expect(out.at(-1)?.time).toBe(T('2026-09-28'));
    expect(out.at(-1)?.volume).toBe(
      descendingRows(4, '2026-10-01').reduce((sum, r) => sum + (r['volume'] as number), 0),
    );
    // Every kept week is a whole one: five sessions' volume at least.
    for (const w of out.slice(0, -1)) expect(w.volume).toBeGreaterThanOrEqual(5000);
  });
});

describe('getBars 1W', () => {
  it('is the aggregate of the daily bars: open from Monday, close from Friday, volume summed', async () => {
    const e = engineWith(eodFixtureFetch());
    const { bars: weeks } = await bars(e, '1W', '2025-10-27', '2025-11-07');
    expect(weeks.map((w) => w.time)).toEqual([T('2025-10-27'), T('2025-11-03')]);
    expect(weeks[0]).toMatchObject({ open: 264.88, close: 270.37, high: 277.32, low: 264.65, volume: 293563399 });
    expect(weeks[1]).toMatchObject({ open: 270.42, close: 268.47, high: 273.4, low: 266.25, volume: 242583991 });
  });

  it('1W agrees with 1D from the same engine (invariant 2 for this pair)', async () => {
    const e = engineWith(eodFixtureFetch());
    const daily = (await bars(e, '1D', '2025-10-27', '2025-11-07')).bars;
    const weekly = (await bars(e, '1W', '2025-10-27', '2025-11-07')).bars;
    const firstWeek = daily.slice(0, 5);
    expect(weekly[0]?.volume).toBe(firstWeek.reduce((s, d) => s + d.volume, 0));
    expect(weekly[0]?.open).toBe(firstWeek[0]?.open);
    expect(weekly[0]?.close).toBe(firstWeek.at(-1)?.close);
    expect(weekly[0]?.high).toBe(Math.max(...firstWeek.map((d) => d.high)));
    expect(weekly[0]?.low).toBe(Math.min(...firstWeek.map((d) => d.low)));
  });

  it('fetches through the Sunday of the week containing `to`, so a mid-week `to` still gets the whole-week bucket', async () => {
    const fetch = eodFixtureFetch();
    await bars(engineWith(fetch), '1W', '2025-10-27', '2025-11-05'); // Wed
    expect(fetch.calls[0]?.searchParams.get('to')).toBe('2025-11-09');
  });

  it('excludes the week whose Monday precedes `from` (inclusive range on bar time)', async () => {
    const e = engineWith(eodFixtureFetch());
    const { bars: weeks } = await bars(e, '1W', '2025-10-28', '2025-11-07');
    expect(weeks.map((w) => w.time)).toEqual([T('2025-11-03')]);
  });
});

describe('unsupported requests', () => {
  it.each(['1m'] as const)('timeframe %s throws an error the provider layer maps to UNAUTHORIZED, without calling upstream', async (timeframe) => {
    const fetch = eodFixtureFetch();
    const err = await engineWith(fetch)
      .getBars({ symbol: 'AAPL', timeframe, from: 0, to: 1, adjusted: true, limit: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnauthorizedError);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
    expect(fetch.calls).toHaveLength(0);
  });

  it('adjusted=false fails cleanly as BAD_REQUEST, without calling upstream', async () => {
    const fetch = eodFixtureFetch();
    const err = await engineWith(fetch)
      .getBars({ symbol: 'AAPL', timeframe: '1D', from: 0, to: T('2025-11-07'), adjusted: false, limit: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedRequestError);
    expect(mapEngineError(err).code).toBe('BAD_REQUEST');
    expect(fetch.calls).toHaveLength(0);
  });

  it('a 402 from upstream on bars surfaces as UNAUTHORIZED, not a 5xx', async () => {
    const e = engineWith(routedFetch({ '/historical-price-eod/full': 'intraday-402' }));
    const err = await bars(e, '1D', '2025-10-27', '2025-11-07').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(FmpPaymentRequiredError);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });

  it('an upstream body of the wrong shape is UPSTREAM_ERROR, not NaN bars', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: '[{"date":"2025-11-05","open":"x"}]' })));
    const err = await bars(e, '1D', '2025-10-27', '2025-11-07').catch((x: unknown) => x);
    expect(mapEngineError(err).code).toBe('UPSTREAM_ERROR');
  });
});

describe('resolveSymbol', () => {
  const profileFetch = () => routedFetch({ '/profile': 'profile-aapl' });

  it('is case-insensitive and returns the canonical symbol', async () => {
    const fetch = profileFetch();
    const r = await engineWith(fetch).resolveSymbol(' aapl ');
    expect(r).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', type: 'CS' });
    expect(fetch.calls[0]?.searchParams.get('symbol')).toBe('AAPL');
  });

  it('caches: a second lookup in any case costs no request', async () => {
    const fetch = profileFetch();
    const e = engineWith(fetch);
    await e.resolveSymbol('AAPL');
    await e.resolveSymbol('aapl');
    expect(fetch.calls).toHaveLength(1);
  });

  it('an unknown symbol (FMP answers 402 with a symbol-scoped body) is undefined, and that is cached briefly', async () => {
    const fetch = routedFetch({ '/profile': 'eod-unknown' });
    const e = engineWith(fetch);
    expect(await e.resolveSymbol('ZZZZNOPE')).toBeUndefined();
    expect(await e.resolveSymbol('zzzznope')).toBeUndefined();
    expect(fetch.calls).toHaveLength(1);
  });

  it('an empty profile list is also unknown', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: '[]' })));
    expect(await e.resolveSymbol('NOPE')).toBeUndefined();
  });

  it('never sends a malformed ticker upstream', async () => {
    const fetch = profileFetch();
    const e = engineWith(fetch);
    for (const bad of ['', '   ', 'AAPL&apikey=x', '../quote', 'A'.repeat(40)]) expect(await e.resolveSymbol(bad)).toBeUndefined();
    expect(fetch.calls).toHaveLength(0);
  });

  it('a restricted ENDPOINT (not symbol) is a tier failure, not "unknown symbol"', async () => {
    const e = engineWith(routedFetch({ '/profile': 'intraday-402' }));
    const err = await e.resolveSymbol('AAPL').catch((x: unknown) => x);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });
});

describe('searchSymbols', () => {
  const EMPTY = () => responseOf({ status: 200, body: '[]' });

  it('maps rows, nulls what upstream does not say, and preserves FMP order', async () => {
    const e = engineWith(routedFetch({ '/search-symbol': 'search-app' }));
    const out = await e.searchSymbols('app', 5);
    expect(out.map((r) => r.symbol)).toEqual(['APP', 'APPC', 'APPB', 'APPM', 'APPN']);
    expect(out[0]).toEqual({ symbol: 'APP', name: 'AppLovin Corporation', exchange: 'NASDAQ', type: null, currency: 'USD', active: true });
  });

  it('lifts an exact ticker match to the front without reordering the rest', async () => {
    const e = engineWith(routedFetch({ '/search-symbol': 'search-app' }));
    const out = await e.searchSymbols('appn', 5);
    expect(out.map((r) => r.symbol)).toEqual(['APPN', 'APP', 'APPC', 'APPB', 'APPM']);
  });

  it('does not spend a second request when tickers already fill the limit', async () => {
    const fetch = routedFetch({ '/search-symbol': 'search-app' });
    await engineWith(fetch).searchSymbols('app', 5);
    expect(fetch.calls.map((c) => c.pathname)).toEqual(['/stable/search-symbol']);
  });

  it('finds a company by NAME through search-name when the ticker search is empty (recorded: "apple")', async () => {
    const fetch = routedFetch({ '/search-symbol': EMPTY, '/search-name': 'search-name-apple' });
    const out = await engineWith(fetch).searchSymbols('apple', 5);
    // Foreign listings (AAPL.MX, AAPL.TO, AAPL.DE ...) and the crypto pair are filtered out.
    expect(out.map((r) => r.symbol)).toEqual(['AAPL', 'APPLX']);
    expect(fetch.calls.map((c) => c.pathname)).toEqual(['/stable/search-symbol', '/stable/search-name']);
  });

  it('de-duplicates a symbol that both endpoints return', async () => {
    const fetch = routedFetch({ '/search-symbol': 'search-name-apple', '/search-name': 'search-name-apple' });
    const out = await engineWith(fetch).searchSymbols('apple', 10);
    expect(out.map((r) => r.symbol)).toEqual(['AAPL', 'APPLX']);
  });

  it('caches identical queries and over-asks upstream so filtering cannot leave the caller short', async () => {
    const fetch = routedFetch({ '/search-symbol': 'search-app' });
    const e = engineWith(fetch);
    await e.searchSymbols('app', 5);
    await e.searchSymbols('APP ', 5);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.searchParams.get('limit')).toBe('15');
  });

  it('no match is an empty array, and a blank query never goes upstream', async () => {
    const fetch = fakeFetch(EMPTY);
    const e = engineWith(fetch);
    expect(await e.searchSymbols('zzzz', 5)).toEqual([]);
    expect(await e.searchSymbols('   ', 5)).toEqual([]);
    expect(fetch.calls).toHaveLength(2); // one query, both endpoints
  });
});

describe('getSnapshot', () => {
  const quoteFetch = () => routedFetch({ '/quote': 'quote-aapl' });

  it('converts changePercentage (a percentage) to our fraction', async () => {
    const snap = await engineWith(quoteFetch()).getSnapshot('aapl', 0);
    expect(snap.changePercent).toBeCloseTo(0.0102022, 8);
    expect(snap).toMatchObject({ symbol: 'AAPL', price: 333.69, previousClose: 330.32, dayVolume: 31878433, updated: 1790971201 });
  });

  it('is reported as delayed unless the operator opts out (see FmpEngine.delayed)', async () => {
    expect(engineWith(quoteFetch()).delayed).toBe(true);
    expect((await engineWith(quoteFetch()).getSnapshot('AAPL', 0)).delayed).toBe(true);
    const live = engineWith(quoteFetch(), { delayed: false });
    expect(live.delayed).toBe(false);
    expect((await live.getSnapshot('AAPL', 0)).delayed).toBe(false);
  });

  it('an empty quote list is an unknown symbol', async () => {
    const e = engineWith(fakeFetch(() => responseOf({ status: 200, body: '[]' })));
    await expect(e.getSnapshot('NOPE', 0)).rejects.toBeInstanceOf(UnknownSymbolError);
  });
});
