/**
 * HTTP-layer tests against an in-test fake engine: no network, no real engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TIMEFRAMES } from '@shared/types';
import type { ApiResult, Bar, BarsResponse, IndicatorSeries, SearchResponse, SearchResult, Snapshot, Timeframe } from '@shared/types';
import { BarsCache, INTRADAY_TTL_MS, DAILY_TTL_MS } from '../cache/barsCache';
import { buildServer } from '../index';
import { UnknownSymbolError } from '../market/types';
import type { EngineBarsRequest, EngineBarsResult, EngineSymbol, MarketEngine } from '../market/types';
import { BAR_CAPS, windowSeconds } from '../provider/service';
import { RateLimitedError, UpstreamTimeoutError, UpstreamUnauthorizedError } from '../provider/errors';

// ───────────────────────────── fake engine ─────────────────────────────

const DAY = 86_400;
const T0 = 1_700_000_000;

const SYMBOLS: EngineSymbol[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'XNAS', type: 'CS', currency: 'USD', listedAt: 0 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', exchange: 'XNAS', type: 'CS', currency: 'USD', listedAt: 0 },
];

function makeBars(from: number, count: number, step = DAY): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i;
    return { time: from + i * step, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000 + i, vwap: null, transactions: null };
  });
}

function makeSnapshot(symbol: string): Snapshot {
  return {
    symbol,
    price: 101.23,
    change: 1.23,
    changePercent: 0.0123,
    previousClose: 100,
    dayOpen: 100.5,
    dayHigh: 102,
    dayLow: 99.5,
    dayVolume: 12345,
    updated: T0,
    delayed: false,
  };
}

interface FakeEngine extends MarketEngine {
  getBars: ReturnType<typeof vi.fn<(req: EngineBarsRequest) => EngineBarsResult>>;
  getSnapshot: ReturnType<typeof vi.fn<(symbol: string, asOf: number) => Snapshot>>;
  searchSymbols: ReturnType<typeof vi.fn<(q: string, limit: number) => SearchResult[]>>;
  resolveSymbol: ReturnType<typeof vi.fn<(symbol: string) => EngineSymbol | undefined>>;
  delayed: boolean;
}

function fakeEngine(overrides: { delayed?: boolean } = {}): FakeEngine {
  return {
    supportedTimeframes: TIMEFRAMES,
    delayed: overrides.delayed ?? false,
    // Case-insensitive, like the real seam documents.
    resolveSymbol: vi.fn((s: string) => SYMBOLS.find((x) => x.symbol === s.toUpperCase())),
    searchSymbols: vi.fn((q: string, limit: number): SearchResult[] =>
      SYMBOLS.filter((s) => s.symbol.startsWith(q.toUpperCase()))
        .slice(0, limit)
        .map((s) => ({ symbol: s.symbol, name: s.name, exchange: s.exchange, type: s.type, currency: s.currency, active: true })),
    ),
    getBars: vi.fn((req: EngineBarsRequest): EngineBarsResult => {
      if (!SYMBOLS.some((s) => s.symbol === req.symbol)) throw new UnknownSymbolError(req.symbol);
      // One daily-spaced bar per step in [from, to], at most 30 (the fake's own size).
      const count = Math.max(0, Math.min(30, Math.floor((req.to - req.from) / DAY) + 1));
      return { bars: makeBars(req.from, count), truncated: false };
    }),
    getSnapshot: vi.fn((symbol: string): Snapshot => {
      if (!SYMBOLS.some((s) => s.symbol === symbol)) throw new UnknownSymbolError(symbol);
      return makeSnapshot(symbol);
    }),
  };
}

// ───────────────────────────── helpers ─────────────────────────────

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(engine: MarketEngine, opts: Partial<Parameters<typeof buildServer>[0]> = {}): FastifyInstance {
  app = buildServer({ engine, ...opts });
  return app;
}

async function get<T>(a: FastifyInstance, url: string) {
  const res = await a.inject({ method: 'GET', url });
  return { status: res.statusCode, headers: res.headers, body: res.json<ApiResult<T>>() };
}

function expectOk<T>(body: ApiResult<T>): T {
  expect(body.ok).toBe(true);
  if (!body.ok) throw new Error('expected ok');
  return body.data;
}

function expectErr(body: ApiResult<unknown>) {
  expect(body.ok).toBe(false);
  if (body.ok) throw new Error('expected error');
  return body.error;
}

const BARS_URL = `/api/bars?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 40 * DAY}`;

// ───────────────────────────── success shapes ─────────────────────────────

describe('GET /api/search', () => {
  it('returns { query, results } as an ok envelope', async () => {
    const { status, body } = await get<SearchResponse>(server(fakeEngine()), '/api/search?q=aa');
    expect(status).toBe(200);
    const data = expectOk(body);
    expect(data.query).toBe('aa');
    expect(data.results).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'XNAS', type: 'CS', currency: 'USD', active: true },
    ]);
  });

  it('trims the query before use and before echoing it', async () => {
    const engine = fakeEngine();
    const { body } = await get<SearchResponse>(server(engine), '/api/search?q=%20%20aa%20');
    expect(expectOk(body).query).toBe('aa');
    expect(engine.searchSymbols.mock.calls[0]?.[0]).toBe('aa');
  });

  it('returns success with results: [] when nothing matches (not a 404)', async () => {
    const { status, body } = await get<SearchResponse>(server(fakeEngine()), '/api/search?q=zzzz');
    expect(status).toBe(200);
    expect(expectOk(body).results).toEqual([]);
  });

  it('filters out inactive symbols and preserves engine order', async () => {
    const engine = fakeEngine();
    const mk = (symbol: string, active: boolean): SearchResult => ({ symbol, name: symbol, exchange: null, type: null, currency: 'USD', active });
    engine.searchSymbols.mockReturnValue([mk('ZZZ', true), mk('DEAD', false), mk('AAA', true)]);
    const { body } = await get<SearchResponse>(server(engine), '/api/search?q=x');
    expect(expectOk(body).results.map((r) => r.symbol)).toEqual(['ZZZ', 'AAA']);
  });

  it('applies limit after filtering', async () => {
    const engine = fakeEngine();
    const mk = (symbol: string, active: boolean): SearchResult => ({ symbol, name: symbol, exchange: null, type: null, currency: 'USD', active });
    engine.searchSymbols.mockReturnValue([mk('A', false), mk('B', true), mk('C', true), mk('D', true)]);
    const { body } = await get<SearchResponse>(server(engine), '/api/search?q=x&limit=2');
    expect(expectOk(body).results.map((r) => r.symbol)).toEqual(['B', 'C']);
  });

  it('defaults limit to 10', async () => {
    const engine = fakeEngine();
    const many = Array.from({ length: 30 }, (_, i): SearchResult => ({ symbol: `S${i}`, name: 'n', exchange: null, type: null, currency: 'USD', active: true }));
    engine.searchSymbols.mockReturnValue(many);
    const { body } = await get<SearchResponse>(server(engine), '/api/search?q=s');
    expect(expectOk(body).results).toHaveLength(10);
  });
});

describe('GET /api/bars', () => {
  it('returns a BarsResponse envelope with the canonical symbol and cached: false', async () => {
    const { status, body } = await get<BarsResponse>(server(fakeEngine()), BARS_URL);
    expect(status).toBe(200);
    const data = expectOk(body);
    expect(data).toMatchObject({ symbol: 'AAPL', timeframe: '1D', adjusted: true, truncated: false, cached: false });
    expect(data.bars).toHaveLength(30);
    expect(data.bars[0]).toEqual({ time: T0, open: 99.5, high: 101, low: 99, close: 100, volume: 1000, vwap: null, transactions: null });
  });

  it('defaults adjusted to true and honours adjusted=false', async () => {
    const engine = fakeEngine();
    const a = server(engine);
    await get(a, BARS_URL);
    await get(a, `${BARS_URL}&adjusted=false`);
    expect(engine.getBars.mock.calls.map((c) => c[0].adjusted)).toEqual([true, false]);
  });

  it('passes unix seconds through to the engine untouched', async () => {
    const engine = fakeEngine();
    await get(server(engine), BARS_URL);
    expect(engine.getBars.mock.calls[0]?.[0]).toMatchObject({ from: T0, to: T0 + 40 * DAY });
  });

  it('hands the engine the symbol as the caller typed it, to resolve (no upcasing in the route)', async () => {
    const engine = fakeEngine();
    const { body } = await get<BarsResponse>(server(engine), BARS_URL.replace('AAPL', 'aapl'));
    expect(engine.resolveSymbol).toHaveBeenCalledWith('aapl');
    // getBars gets the engine's own canonical form, as its request type documents.
    expect(engine.getBars.mock.calls[0]?.[0].symbol).toBe('AAPL');
    expect(expectOk(body).symbol).toBe('AAPL');
  });

  it('reports truncated from the engine', async () => {
    const engine = fakeEngine();
    engine.getBars.mockReturnValue({ bars: makeBars(T0, 3), truncated: true });
    const { body } = await get<BarsResponse>(server(engine), BARS_URL);
    expect(expectOk(body).truncated).toBe(true);
  });

  it('returns ok:true with bars: [] for a valid-but-empty range, never NO_DATA', async () => {
    const engine = fakeEngine();
    engine.getBars.mockReturnValue({ bars: [], truncated: false });
    const { status, body } = await get<BarsResponse>(server(engine), BARS_URL);
    expect(status).toBe(200);
    expect(expectOk(body).bars).toEqual([]);
  });

  it('keeps bars strictly increasing even if an engine hands back duplicates or disorder', async () => {
    const engine = fakeEngine();
    const [a, b, c] = makeBars(T0, 3);
    engine.getBars.mockReturnValue({ bars: [c, a, b, a].filter((x): x is Bar => x !== undefined), truncated: false });
    const { body } = await get<BarsResponse>(server(engine), BARS_URL);
    const times = expectOk(body).bars.map((x) => x.time);
    expect(times).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
  });
});

describe('GET /api/bars truncation keeps the NEWEST bars', () => {
  // 30 daily bars from `from`; the fake honours `limit` the way the engine seam
  // documents: the most recent `limit` bars in range, truncated: true when it clipped.
  function limitHonouringEngine(): FakeEngine {
    const engine = fakeEngine();
    engine.getBars.mockImplementation((req) => {
      const all = makeBars(req.from, Math.max(0, Math.min(30, Math.floor((req.to - req.from) / DAY) + 1)));
      const bars = all.slice(Math.max(0, all.length - req.limit));
      return { bars, truncated: all.length > req.limit };
    });
    return engine;
  }
  // BARS_URL spans 40 days. With a cap of 5 the proxy narrows the range to the newest
  // ~17 days before the engine sees it, so the newest bar in range is T0 + 40 days.
  const newest = T0 + 40 * DAY;

  it('passes a limit to the engine and returns the tail of the range, not the head', async () => {
    const engine = limitHonouringEngine();
    const { body } = await get<BarsResponse>(server(engine, { maxBars: 5 }), BARS_URL);
    const data = expectOk(body);
    expect(engine.getBars.mock.calls[0]?.[0].limit).toBe(5);
    expect(data.truncated).toBe(true);
    expect(data.bars).toHaveLength(5);
    // Ends at the newest bar in range and begins well after `from`: the OLD edge is partial.
    expect(data.bars.at(-1)?.time).toBe(newest);
    expect(data.bars[0]?.time).toBe(newest - 4 * DAY);
    expect(data.bars[0]?.time).toBeGreaterThan(T0);
  });

  it('is not truncated when the range fits under the cap', async () => {
    const { body } = await get<BarsResponse>(server(limitHonouringEngine(), { maxBars: 30 }), BARS_URL);
    const data = expectOk(body);
    expect(data.truncated).toBe(false);
    expect(data.bars[0]?.time).toBe(T0);
  });

  it('clips the OLD end itself if an engine ignores limit, and flags truncated', async () => {
    const engine = fakeEngine(); // returns every bar it has regardless of limit
    const { body } = await get<BarsResponse>(server(engine, { maxBars: 5 }), BARS_URL);
    const data = expectOk(body);
    expect(data.truncated).toBe(true);
    expect(data.bars).toHaveLength(5);
    expect(data.bars.at(-1)?.time).toBe(newest);
  });

  it.each(Object.entries(BAR_CAPS))('caps %s requests at %i bars', async (tf, cap) => {
    const engine = fakeEngine();
    await get(server(engine), BARS_URL.replace('timeframe=1D', `timeframe=${tf}`));
    expect(engine.getBars.mock.calls[0]?.[0].limit).toBe(cap);
  });
});

describe('request bounds: the range is narrowed before the engine sees it', () => {
  const wide = (tf: string) => `/api/bars?symbol=AAPL&timeframe=${tf}&from=0&to=${T0}`;

  it.each(Object.keys(BAR_CAPS) as Timeframe[])('%s: an all-history request reaches the engine as a bounded window', async (tf) => {
    const engine = fakeEngine();
    const { body } = await get<BarsResponse>(server(engine), wide(tf));
    const call = engine.getBars.mock.calls[0]?.[0];
    expect(call?.to).toBe(T0);
    expect(call?.from).toBe(T0 - windowSeconds(tf, BAR_CAPS[tf]));
    expect(call?.from).toBeGreaterThan(0);
    // Range the caller asked for but was not served: they must walk backwards.
    expect(expectOk(body).truncated).toBe(true);
  });

  it('a request already inside the window is passed through whole and is not marked truncated', async () => {
    const engine = fakeEngine();
    const { body } = await get<BarsResponse>(server(engine), BARS_URL);
    expect(engine.getBars.mock.calls[0]?.[0].from).toBe(T0);
    expect(expectOk(body).truncated).toBe(false);
  });

  it('windows are generous: they hold more than a cap of bars on a normal calendar', () => {
    // 390 one-minute bars per session; ~5 sessions a week.
    expect((windowSeconds('1m', 10_000) / DAY) * (5 / 7) * 390).toBeGreaterThan(10_000);
    expect((windowSeconds('1D', 2_000) / DAY) * (5 / 7)).toBeGreaterThan(2_000);
    expect(windowSeconds('1W', 400) / (7 * DAY)).toBeGreaterThan(400);
  });

  it('negative from is clamped to 0, not rejected', async () => {
    const engine = fakeEngine();
    const { status, body } = await get<BarsResponse>(server(engine), `/api/bars?symbol=AAPL&timeframe=1D&from=-317156403&to=${T0}`);
    expect(status).toBe(200);
    expectOk(body);
    // Clamped to 0 and then narrowed like any other all-history request.
    expect(engine.getBars.mock.calls[0]?.[0].from).toBe(T0 - windowSeconds('1D', BAR_CAPS['1D']));
  });

  it('clamps a negative from on the indicator endpoint too', async () => {
    const { status } = await get(server(fakeEngine()), `/api/indicator?symbol=AAPL&timeframe=1D&from=-5&to=${T0}&kind=sma&period=3`);
    expect(status).toBe(200);
  });

  it('still rejects a negative to, and from that is garbage', async () => {
    const a = server(fakeEngine());
    expect((await get(a, '/api/bars?symbol=AAPL&timeframe=1D&from=0&to=-1')).status).toBe(400);
    expect((await get(a, '/api/bars?symbol=AAPL&timeframe=1D&from=abc&to=5')).status).toBe(400);
    expect((await get(a, '/api/bars?symbol=AAPL&timeframe=1D&from=-1.5&to=5')).status).toBe(400);
    expect((await get(a, `/api/bars?symbol=AAPL&timeframe=1D&from=${T0 * 1000}&to=${T0 * 1000 + 1}`)).status).toBe(400);
  });
});

describe('GET /api/snapshot', () => {
  it('returns the Snapshot, with changePercent as a fraction (not pre-multiplied)', async () => {
    const { status, body } = await get<Snapshot>(server(fakeEngine()), '/api/snapshot?symbol=AAPL');
    expect(status).toBe(200);
    const data = expectOk(body);
    expect(data.symbol).toBe('AAPL');
    expect(data.changePercent).toBe(0.0123);
    expect(data.price).toBe(101.23);
  });

  it('passes null price fields through as null, never 0', async () => {
    const engine = fakeEngine();
    engine.getSnapshot.mockReturnValue({ ...makeSnapshot('AAPL'), price: null, change: null, changePercent: null, dayHigh: null });
    const data = expectOk((await get<Snapshot>(server(engine), '/api/snapshot?symbol=AAPL')).body);
    expect(data).toMatchObject({ price: null, change: null, changePercent: null, dayHigh: null });
  });

  it('sets delayed from the engine tier, not a hardcoded literal', async () => {
    const delayed = expectOk((await get<Snapshot>(server(fakeEngine({ delayed: true })), '/api/snapshot?symbol=AAPL')).body);
    expect(delayed.delayed).toBe(true);
    await app?.close();
    const live = expectOk((await get<Snapshot>(server(fakeEngine({ delayed: false })), '/api/snapshot?symbol=AAPL')).body);
    expect(live.delayed).toBe(false);
  });

  it('asks the engine for the snapshot as of "now" in unix seconds', async () => {
    const engine = fakeEngine();
    await get(server(engine, { now: () => 1_700_000_123 }), '/api/snapshot?symbol=AAPL');
    expect(engine.getSnapshot).toHaveBeenCalledWith('AAPL', 1_700_000_123);
  });
});

describe('GET /api/indicator (oracle/debug)', () => {
  const url = (extra: string) => `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 40 * DAY}&${extra}`;

  it('returns a single "value" line for sma with null warmup', async () => {
    const { status, body } = await get<IndicatorSeries>(server(fakeEngine()), url('kind=sma&period=5'));
    expect(status).toBe(200);
    const data = expectOk(body);
    expect(data).toMatchObject({ kind: 'sma', placement: 'overlay', params: { period: 5 }, warmup: 4 });
    expect(data.lines.map((l) => l.key)).toEqual(['value']);
    const pts = data.lines[0]?.points ?? [];
    expect(pts).toHaveLength(30);
    expect(pts.slice(0, 4).every((p) => p.value === null)).toBe(true);
    // closes are 100,101,...; mean of the first five is 102
    expect(pts[4]?.value).toBe(102);
  });

  it('returns macd lines keyed macd, signal, histogram in that order', async () => {
    const data = expectOk((await get<IndicatorSeries>(server(fakeEngine()), url('kind=macd&fastPeriod=3&slowPeriod=6&signalPeriod=3'))).body);
    expect(data.kind).toBe('macd');
    expect(data.placement).toBe('separate');
    expect(data.lines.map((l) => l.key)).toEqual(['macd', 'signal', 'histogram']);
    expect(data.params).toEqual({ fastPeriod: 3, slowPeriod: 6, signalPeriod: 3 });
  });

  it('returns rsi and ema as single-line separate/overlay series', async () => {
    const rsi = expectOk((await get<IndicatorSeries>(server(fakeEngine()), url('kind=rsi&period=14'))).body);
    expect(rsi.placement).toBe('separate');
    expect(rsi.lines).toHaveLength(1);
    await app?.close();
    const ema = expectOk((await get<IndicatorSeries>(server(fakeEngine()), url('kind=ema&period=5'))).body);
    expect(ema.placement).toBe('overlay');
  });
});

describe('GET /api/health', () => {
  it('stays up and returns the envelope', async () => {
    const { status, body } = await get<{ status: string }>(server(fakeEngine()), '/api/health');
    expect(status).toBe(200);
    expect(expectOk(body)).toEqual({ status: 'up' });
  });
});

// ───────────────────────────── validation ─────────────────────────────

describe('input validation (zod → BAD_REQUEST/400, naming the parameter)', () => {
  const cases: [string, string, string][] = [
    ['search without q', '/api/search', 'q'],
    ['search with empty q', '/api/search?q=', 'q'],
    ['search with whitespace-only q', '/api/search?q=%20%20', 'q'],
    ['search with q too long', `/api/search?q=${'a'.repeat(33)}`, 'q'],
    ['search limit 0', '/api/search?q=a&limit=0', 'limit'],
    ['search limit 51', '/api/search?q=a&limit=51', 'limit'],
    ['search limit non-integer', '/api/search?q=a&limit=abc', 'limit'],
    ['bars without symbol', `/api/bars?timeframe=1D&from=${T0}&to=${T0 + 1}`, 'symbol'],
    ['bars symbol too long', `/api/bars?symbol=${'A'.repeat(17)}&timeframe=1D&from=${T0}&to=${T0 + 1}`, 'symbol'],
    ['bars without timeframe', `/api/bars?symbol=AAPL&from=${T0}&to=${T0 + 1}`, 'timeframe'],
    ['bars unknown timeframe', `/api/bars?symbol=AAPL&timeframe=2D&from=${T0}&to=${T0 + 1}`, 'timeframe'],
    ['bars without from', `/api/bars?symbol=AAPL&timeframe=1D&to=${T0}`, 'from'],
    ['bars without to', `/api/bars?symbol=AAPL&timeframe=1D&from=${T0}`, 'to'],
    ['bars to < from', `/api/bars?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 - 1}`, 'to'],
    ['bars fractional from', `/api/bars?symbol=AAPL&timeframe=1D&from=1.5&to=${T0}`, 'from'],
    ['bars millisecond timestamps', `/api/bars?symbol=AAPL&timeframe=1D&from=${T0 * 1000}&to=${T0 * 1000 + 1}`, 'from'],
    ['bars bad adjusted', `/api/bars?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&adjusted=maybe`, 'adjusted'],
    ['bars repeated symbol', `/api/bars?symbol=AAPL&symbol=MSFT&timeframe=1D&from=${T0}&to=${T0 + 1}`, 'symbol'],
    ['snapshot without symbol', '/api/snapshot', 'symbol'],
    ['indicator unknown kind', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=bollinger&period=5`, 'kind'],
    ['indicator without kind', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&period=5`, 'kind'],
    ['indicator sma without period', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=sma`, 'period'],
    ['indicator period 0', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=sma&period=0`, 'period'],
    ['indicator period too large', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=sma&period=501`, 'period'],
    ['indicator macd missing signalPeriod', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=macd&fastPeriod=3&slowPeriod=6`, 'signalPeriod'],
    ['indicator macd fast >= slow', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 + 1}&kind=macd&fastPeriod=6&slowPeriod=6&signalPeriod=3`, 'fastPeriod'],
    ['indicator to < from', `/api/indicator?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0 - 1}&kind=sma&period=5`, 'to'],
    ['indicator unknown timeframe', `/api/indicator?symbol=AAPL&timeframe=3m&from=${T0}&to=${T0 + 1}&kind=sma&period=5`, 'timeframe'],
  ];

  it.each(cases)('%s', async (_name, url, param) => {
    const engine = fakeEngine();
    const { status, body } = await get(server(engine), url);
    expect(status).toBe(400);
    const error = expectErr(body);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain(`"${param}"`);
    // Rejected before any engine work.
    expect(engine.getBars).not.toHaveBeenCalled();
    expect(engine.searchSymbols).not.toHaveBeenCalled();
    await app?.close();
  });

  it('accepts to === from', async () => {
    const { status } = await get(server(fakeEngine()), `/api/bars?symbol=AAPL&timeframe=1D&from=${T0}&to=${T0}`);
    expect(status).toBe(200);
  });

  it('answers an unknown path with an envelope, not Fastify default JSON', async () => {
    const { status, body } = await get(server(fakeEngine()), '/api/nope');
    expect(status).toBe(404);
    expect(expectErr(body).code).toBe('BAD_REQUEST');
  });
});

// ───────────────────────────── error mapping ─────────────────────────────

describe('error mapping', () => {
  it('maps an unknown symbol to 404 UNKNOWN_SYMBOL on bars, snapshot and indicator', async () => {
    const a = server(fakeEngine());
    for (const url of [
      `/api/bars?symbol=NOPE&timeframe=1D&from=${T0}&to=${T0 + DAY}`,
      '/api/snapshot?symbol=NOPE',
      `/api/indicator?symbol=NOPE&timeframe=1D&from=${T0}&to=${T0 + DAY}&kind=sma&period=3`,
    ]) {
      const { status, body } = await get(a, url);
      expect(status, url).toBe(404);
      expect(expectErr(body).code).toBe('UNKNOWN_SYMBOL');
    }
  });

  it('maps an UnknownSymbolError thrown by getBars itself to 404 as well', async () => {
    const engine = fakeEngine();
    engine.getBars.mockImplementation((r) => {
      throw new UnknownSymbolError(r.symbol);
    });
    const { status, body } = await get(server(engine), BARS_URL);
    expect(status).toBe(404);
    expect(expectErr(body).code).toBe('UNKNOWN_SYMBOL');
  });

  it('maps a rate-limit to 429 RATE_LIMITED carrying retryAfterSeconds (body and header)', async () => {
    const engine = fakeEngine();
    engine.getBars.mockImplementation(() => {
      throw new RateLimitedError(12);
    });
    const { status, headers, body } = await get(server(engine), BARS_URL);
    expect(status).toBe(429);
    expect(expectErr(body)).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 });
    expect(headers['retry-after']).toBe('12');
  });

  it('maps a generic engine throw to 502 UPSTREAM_ERROR', async () => {
    const engine = fakeEngine();
    engine.getBars.mockImplementation(() => {
      throw new Error('boom');
    });
    const { status, body } = await get(server(engine), BARS_URL);
    expect(status).toBe(502);
    expect(expectErr(body).code).toBe('UPSTREAM_ERROR');
  });

  it('maps timeout to 504 and auth failure to 500 UNAUTHORIZED', async () => {
    const engine = fakeEngine();
    engine.getSnapshot.mockImplementationOnce(() => {
      throw new UpstreamTimeoutError();
    });
    const a = server(engine);
    const t = await get(a, '/api/snapshot?symbol=AAPL');
    expect(t.status).toBe(504);
    expect(expectErr(t.body).code).toBe('UPSTREAM_TIMEOUT');

    engine.getSnapshot.mockImplementationOnce(() => {
      throw new UpstreamUnauthorizedError();
    });
    const u = await get(a, '/api/snapshot?symbol=AAPL');
    expect(u.status).toBe(500);
    expect(expectErr(u.body).code).toBe('UNAUTHORIZED');
  });

  it('maps engine failures on search and snapshot too', async () => {
    const engine = fakeEngine();
    engine.searchSymbols.mockImplementation(() => {
      throw new Error('boom');
    });
    engine.getSnapshot.mockImplementation(() => {
      throw new Error('boom');
    });
    const a = server(engine);
    expect((await get(a, '/api/search?q=a')).status).toBe(502);
    expect((await get(a, '/api/snapshot?symbol=AAPL')).status).toBe(502);
  });

  it('turns a bug in our own handling (resolveSymbol throwing) into a mapped failure, not a crash', async () => {
    const engine = fakeEngine();
    engine.resolveSymbol.mockImplementation(() => {
      throw new Error('boom');
    });
    const { status, body } = await get(server(engine), BARS_URL);
    expect(status).toBe(502);
    expect(expectErr(body).code).toBe('UPSTREAM_ERROR');
  });
});

// ───────────────────────────── cache ─────────────────────────────

describe('bars cache', () => {
  it('misses then hits, flagging cached correctly and not re-calling the engine', async () => {
    const engine = fakeEngine();
    const a = server(engine);
    const first = expectOk((await get<BarsResponse>(a, BARS_URL)).body);
    const second = expectOk((await get<BarsResponse>(a, BARS_URL)).body);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(engine.getBars).toHaveBeenCalledTimes(1);
    // Identical apart from the diagnostic flag.
    expect({ ...second, cached: false }).toEqual(first);
  });

  it('keeps a cache hit from changing the stored entry (a third request is still cached: true)', async () => {
    const a = server(fakeEngine());
    await get(a, BARS_URL);
    await get(a, BARS_URL);
    expect(expectOk((await get<BarsResponse>(a, BARS_URL)).body).cached).toBe(true);
  });

  it('keys on symbol, timeframe, from, to and adjusted', async () => {
    const engine = fakeEngine();
    const a = server(engine);
    await get(a, BARS_URL);
    await get(a, BARS_URL.replace('timeframe=1D', 'timeframe=1W'));
    await get(a, BARS_URL.replace('AAPL', 'MSFT'));
    await get(a, `${BARS_URL}&adjusted=false`);
    await get(a, BARS_URL.replace(`from=${T0}`, `from=${T0 + 1}`));
    await get(a, BARS_URL.replace(`to=${T0 + 40 * DAY}`, `to=${T0 + 41 * DAY}`));
    expect(engine.getBars).toHaveBeenCalledTimes(6);
  });

  it('shares an entry between spellings that resolve to the same canonical symbol', async () => {
    const engine = fakeEngine();
    const a = server(engine);
    await get(a, BARS_URL);
    const hit = expectOk((await get<BarsResponse>(a, BARS_URL.replace('AAPL', 'aapl'))).body);
    expect(hit.cached).toBe(true);
    expect(engine.getBars).toHaveBeenCalledTimes(1);
  });

  it('caches an empty-but-valid result like any other success', async () => {
    const engine = fakeEngine();
    engine.getBars.mockReturnValue({ bars: [], truncated: false });
    const a = server(engine);
    await get(a, BARS_URL);
    expect(expectOk((await get<BarsResponse>(a, BARS_URL)).body).cached).toBe(true);
  });

  it('does not cache errors: a failure followed by recovery serves fresh data', async () => {
    const engine = fakeEngine();
    engine.getBars.mockImplementationOnce(() => {
      throw new RateLimitedError(30);
    });
    const a = server(engine);
    expect((await get(a, BARS_URL)).status).toBe(429);
    const retry = await get<BarsResponse>(a, BARS_URL);
    expect(retry.status).toBe(200);
    expect(expectOk(retry.body).cached).toBe(false);
    expect(engine.getBars).toHaveBeenCalledTimes(2);
  });

  it('does not cache a 502 either', async () => {
    const engine = fakeEngine();
    engine.getBars.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const a = server(engine);
    expect((await get(a, BARS_URL)).status).toBe(502);
    expect((await get(a, BARS_URL)).status).toBe(200);
  });

  describe('TTL', () => {
    function clocked() {
      let now = 1_000; // lru-cache treats a start time of 0 as "no TTL"; real clocks are never 0
      const clock = { now: () => now };
      const engine = fakeEngine();
      const a = server(engine, { cache: new BarsCache({ clock }) });
      return { a, engine, advance: (ms: number) => (now += ms) };
    }

    it('expires intraday entries after ~60s', async () => {
      const { a, engine, advance } = clocked();
      const url = BARS_URL.replace('timeframe=1D', 'timeframe=5m');
      await get(a, url);
      advance(INTRADAY_TTL_MS - 1);
      expect(expectOk((await get<BarsResponse>(a, url)).body).cached).toBe(true);
      advance(2);
      expect(expectOk((await get<BarsResponse>(a, url)).body).cached).toBe(false);
      expect(engine.getBars).toHaveBeenCalledTimes(2);
    });

    it('keeps daily entries well past the intraday TTL, and expires them after ~10 min', async () => {
      const { a, engine, advance } = clocked();
      await get(a, BARS_URL);
      advance(INTRADAY_TTL_MS * 5);
      expect(expectOk((await get<BarsResponse>(a, BARS_URL)).body).cached).toBe(true);
      advance(DAILY_TTL_MS);
      expect(expectOk((await get<BarsResponse>(a, BARS_URL)).body).cached).toBe(false);
      expect(engine.getBars).toHaveBeenCalledTimes(2);
    });
  });

  it('evicts the least recently used entry once the summed bar count exceeds the budget', async () => {
    const engine = fakeEngine();
    const a = server(engine, { cache: new BarsCache({ maxBars: 70 }) });
    // Each response is 30 bars, so a 70-bar budget holds two entries; the third evicts the first.
    const at = (n: number) => `/api/bars?symbol=AAPL&timeframe=1D&from=${T0 + n * DAY}&to=${T0 + n * DAY + 40 * DAY}`;
    await get(a, at(1));
    await get(a, at(2));
    await get(a, at(3)); // evicts at(1)
    expect(expectOk((await get<BarsResponse>(a, at(1))).body).cached).toBe(false);
  });
});

// ───────────────────────────── fault injection ─────────────────────────────

describe('fault injection', () => {
  it('answers RATE_LIMITED with retryAfterSeconds when the draw falls in the rate-limit slice', async () => {
    const engine = fakeEngine();
    const a = server(engine, {
      faults: { latencyMs: 0, rateLimitRate: 0.3, errorRate: 0.2, retryAfterSeconds: 7 },
      random: () => 0.1,
    });
    const { status, body, headers } = await get(a, BARS_URL);
    expect(status).toBe(429);
    expect(expectErr(body)).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 7 });
    expect(headers['retry-after']).toBe('7');
    expect(engine.getBars).not.toHaveBeenCalled();
  });

  it('answers UPSTREAM_ERROR when the draw falls in the error slice', async () => {
    const a = server(fakeEngine(), {
      faults: { latencyMs: 0, rateLimitRate: 0.3, errorRate: 0.2, retryAfterSeconds: 7 },
      random: () => 0.4,
    });
    const { status, body } = await get(a, '/api/snapshot?symbol=AAPL');
    expect(status).toBe(502);
    expect(expectErr(body).code).toBe('UPSTREAM_ERROR');
  });

  it('serves normally when the draw is past both slices', async () => {
    const a = server(fakeEngine(), {
      faults: { latencyMs: 0, rateLimitRate: 0.3, errorRate: 0.2, retryAfterSeconds: 7 },
      random: () => 0.9,
    });
    expect((await get(a, BARS_URL)).status).toBe(200);
  });

  it('applies the configured latency before answering', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const a = server(fakeEngine(), { faults: { latencyMs: 250, rateLimitRate: 0, errorRate: 0, retryAfterSeconds: 5 }, sleep });
    await get(a, BARS_URL);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not cache an injected failure, and injects nothing when faults are off', async () => {
    const engine = fakeEngine();
    const a = server(engine, {
      faults: { latencyMs: 0, rateLimitRate: 1, errorRate: 0, retryAfterSeconds: 5 },
      random: () => 0.5,
    });
    expect((await get(a, BARS_URL)).status).toBe(429);
    expect((await get(a, BARS_URL)).status).toBe(429);
    await a.close();
    // `random: () => 0` would hit every fault slice if faults were on.
    const off = server(engine, { random: () => 0 });
    expect((await get(off, BARS_URL)).status).toBe(200);
  });

  it('serves a cache hit even when the next upstream call would be rate limited', async () => {
    const engine = fakeEngine();
    const cache = new BarsCache();
    const warm = server(engine, { cache });
    await get(warm, BARS_URL);
    await warm.close();
    const flaky = server(engine, {
      cache,
      faults: { latencyMs: 0, rateLimitRate: 1, errorRate: 0, retryAfterSeconds: 5 },
      random: () => 0,
    });
    const { status, body } = await get<BarsResponse>(flaky, BARS_URL);
    expect(status).toBe(200);
    expect(expectOk(body).cached).toBe(true);
  });
});
