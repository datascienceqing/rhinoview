import type { ApiResult, BarsResponse, SearchResponse, Snapshot } from '@shared/types';
import { TIMEFRAMES } from '@shared/types';
import searchEmpty from '../../mocks/fixtures/search-empty.json';
import { MOCK_SYMBOLS, sliceBars } from '../../mocks/data';
import { MAX_UNIX_SECONDS } from '../../mocks/handlers';

/**
 * The handlers are the stand-in for the proxy, so they are held to the contract:
 * honour from/to (inclusive), return ok:false envelopes with the mapped status,
 * and be case-sensitive about symbols.
 */
async function call<T>(path: string): Promise<{ status: number; body: ApiResult<T> }> {
  const res = await fetch(new URL(path, 'http://localhost').toString());
  return { status: res.status, body: (await res.json()) as ApiResult<T> };
}

const FAR = MAX_UNIX_SECONDS;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Real clock on purpose: the mock bars are generated relative to today.
const allBars = (tf: Parameters<typeof sliceBars>[0]) => sliceBars(tf, 0, FAR);

describe('mock /api/bars', () => {
  it('slices the daily series to [from, to], inclusive on both ends', async () => {
    const daily = allBars('1D');
    const lo = daily[10]?.time ?? 0;
    const hi = daily[19]?.time ?? 0;
    const { status, body } = await call<BarsResponse>(`/api/bars?symbol=AAPL&timeframe=1D&from=${lo}&to=${hi}`);
    expect(status).toBe(200);
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.bars.map((b) => b.time)).toEqual(daily.slice(10, 20).map((b) => b.time));
  });

  it('returns an empty success (not an error) for a range with no bars', async () => {
    const { status, body } = await call<BarsResponse>('/api/bars?symbol=AAPL&timeframe=1D&from=1000&to=2000');
    expect(status).toBe(200);
    expect(body.ok && body.data.bars).toEqual([]);
  });

  it('never returns a bar after now, and clamps a far-future `to`', async () => {
    const { body } = await call<BarsResponse>(`/api/bars?symbol=AAPL&timeframe=5m&from=0&to=${FAR}`);
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.bars.length).toBeGreaterThan(0);
    expect(Math.max(...body.data.bars.map((b) => b.time))).toBeLessThanOrEqual(nowSeconds());
  });

  it('has recent data whatever today is: the newest daily and 5m bars are within a week', async () => {
    const week = 7 * 86_400;
    expect(allBars('1D').at(-1)?.time ?? 0).toBeGreaterThan(nowSeconds() - week);
    expect(allBars('5m').at(-1)?.time ?? 0).toBeGreaterThan(nowSeconds() - week);
  });

  it('stamps 1D bars at 00:00 America/New_York and weeks on the New York Monday', () => {
    const ny = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    for (const b of [...allBars('1D'), ...allBars('1W')]) {
      const parts = Object.fromEntries(ny.formatToParts(new Date(b.time * 1000)).map((p) => [p.type, p.value]));
      expect(`${parts.hour}:${parts.minute}`).toBe('00:00');
    }
    for (const b of allBars('1W')) {
      expect(ny.formatToParts(new Date(b.time * 1000)).find((p) => p.type === 'weekday')?.value).toBe('Mon');
    }
  });

  it('opens each intraday session at 09:30 New York, whichever side of a DST change it is on', () => {
    const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    const firstOfDay = allBars('1h').filter((_, i, all) => i === 0 || (all[i]?.time ?? 0) - (all[i - 1]?.time ?? 0) > 6 * 3600);
    expect(firstOfDay.length).toBeGreaterThan(50);
    for (const b of firstOfDay) {
      const t = ny.formatToParts(new Date(b.time * 1000));
      expect(`${t.find((p) => p.type === 'hour')?.value}:${t.find((p) => p.type === 'minute')?.value}`).toBe('09:30');
    }
  });

  it('keeps intraday folds exact: 1h volume sums to 5m volume, and 15m high is the max of its 5m highs', () => {
    const five = allBars('5m');
    const hour = allBars('1h');
    expect(hour.reduce((s, b) => s + b.volume, 0)).toBe(five.reduce((s, b) => s + b.volume, 0));
    expect(hour.length).toBeLessThan(five.length);
    const fifteen = allBars('15m');
    const first = fifteen[0];
    const firstFive = five.slice(0, 3);
    expect(first?.high).toBe(Math.max(...firstFive.map((b) => b.high)));
    expect(first?.open).toBe(firstFive[0]?.open);
  });

  it('returns strictly increasing times for every timeframe', async () => {
    for (const tf of TIMEFRAMES) {
      const { body } = await call<BarsResponse>(`/api/bars?symbol=AAPL&timeframe=${tf}&from=0&to=${FAR}`);
      if (!body.ok) throw new Error('expected ok');
      const times = body.data.bars.map((b) => b.time);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size).toBe(times.length);
    }
  });

  it('resolves symbols case-insensitively and echoes the canonical form', async () => {
    const { status, body } = await call<BarsResponse>(`/api/bars?symbol=aapl&timeframe=1D&from=0&to=${FAR}`);
    expect(status).toBe(200);
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.symbol).toBe('AAPL');
    expect(body.data.bars.length).toBeGreaterThan(0);
  });

  it.each([
    ['unknown symbol', 'symbol=ZZZZ&timeframe=1D&from=1&to=2', 404, 'UNKNOWN_SYMBOL'],
    ['lower-case failure symbol still resolves, and fails', `symbol=${MOCK_SYMBOLS.rateLimited.toLowerCase()}&timeframe=1D&from=1&to=2`, 429, 'RATE_LIMITED'],
    ['negative from (the client must never send one)', 'symbol=AAPL&timeframe=1D&from=-1&to=2', 400, 'BAD_REQUEST'],
    ['negative to', 'symbol=AAPL&timeframe=1D&from=0&to=-5', 400, 'BAD_REQUEST'],
    ['millisecond-looking timestamps', 'symbol=AAPL&timeframe=1D&from=1790775000000&to=1790798100000', 400, 'BAD_REQUEST'],
    ['rate limited symbol', `symbol=${MOCK_SYMBOLS.rateLimited}&timeframe=1D&from=1&to=2`, 429, 'RATE_LIMITED'],
    ['upstream error symbol', `symbol=${MOCK_SYMBOLS.upstreamError}&timeframe=1D&from=1&to=2`, 502, 'UPSTREAM_ERROR'],
    ['bad timeframe', 'symbol=AAPL&timeframe=2D&from=1&to=2', 400, 'BAD_REQUEST'],
    ['to before from', 'symbol=AAPL&timeframe=1D&from=5&to=2', 400, 'BAD_REQUEST'],
    ['missing from', 'symbol=AAPL&timeframe=1D&to=2', 400, 'BAD_REQUEST'],
  ])('%s -> contract-valid ok:false envelope', async (_name, query, status, code) => {
    const res = await call<BarsResponse>(`/api/bars?${query}`);
    expect(res.status).toBe(status);
    expect(res.body.ok).toBe(false);
    if (res.body.ok) return;
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.message).toBe('string');
  });

  it('includes retryAfterSeconds on RATE_LIMITED', async () => {
    const { body } = await call<BarsResponse>(`/api/bars?symbol=${MOCK_SYMBOLS.rateLimited}&timeframe=1D&from=1&to=2`);
    if (body.ok) throw new Error('expected failure');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('mock /api/search and /api/snapshot', () => {
  it('returns the AAPL fixture results for "aapl"', async () => {
    const { body } = await call<SearchResponse>('/api/search?q=aapl');
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.results.map((r) => r.symbol)).toEqual(['AAPL', 'AAPL.MX']);
    expect(body.data.results[1]?.exchange).toBeNull();
  });

  it('returns success with an empty array when nothing matches', async () => {
    const { status, body } = await call<SearchResponse>('/api/search?q=zzzzzz');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { ...searchEmpty.data, query: 'zzzzzz' } });
  });

  it('rejects an empty query with BAD_REQUEST', async () => {
    const res = await call<SearchResponse>('/api/search?q=%20');
    expect(res.status).toBe(400);
  });

  it('resolves a lower-case snapshot symbol and echoes the canonical one', async () => {
    const { body } = await call<Snapshot>('/api/snapshot?symbol=aapl');
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.symbol).toBe('AAPL');
  });

  it('serves the AAPL snapshot with fractional changePercent and delayed:true', async () => {
    const { body } = await call<Snapshot>('/api/snapshot?symbol=AAPL');
    if (!body.ok) throw new Error('expected ok');
    expect(body.data.changePercent).toBeCloseTo(0.006674);
    expect(body.data.delayed).toBe(true);
  });

  it('404s an unknown snapshot symbol', async () => {
    const res = await call<Snapshot>('/api/snapshot?symbol=NOPE');
    expect(res.status).toBe(404);
  });
});
