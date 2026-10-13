/**
 * `GET /api/capabilities`, and the proxy-side backstop for a timeframe the active
 * provider cannot serve. A stale client that ignores capabilities must get a clean
 * UNAUTHORIZED, with no upstream call and no cache entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TIMEFRAMES } from '@shared/types';
import type { ApiResult, Bar, BarsResponse, Timeframe } from '@shared/types';
import { buildServer } from '../index';
import { UnsupportedRequestError } from '../provider/errors';
import type { EngineBarsRequest, EngineBarsResult, MarketEngine } from '../market/types';

const DAY = 86_400;
const NOW = 1_700_000_000; // 2023-11-14 22:13:20 UTC
const AAPL = { symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', type: 'CS', currency: 'USD', listedAt: 0 };

function dailyBar(time: number): Bar {
  return { time, open: 1, high: 2, low: 1, close: 2, volume: 10, vwap: null, transactions: null };
}

/** An end-of-day engine: no minute data, like the FMP free tier. */
function eodEngine(overrides: Partial<Omit<MarketEngine, 'getBars'>> = {}) {
  const getBars = vi.fn((req: EngineBarsRequest): EngineBarsResult => {
    // The newest bar is today's, stamped at its open, so it straddles `now`.
    const today = Math.floor(NOW / DAY) * DAY;
    return { bars: req.from <= today ? [dailyBar(today - DAY), dailyBar(today)] : [], truncated: false };
  });
  const engine: MarketEngine & { getBars: typeof getBars } = {
    supportedTimeframes: ['1D', '1W'],
    delayed: true,
    resolveSymbol: (s) => (s.toUpperCase() === 'AAPL' ? AAPL : undefined),
    searchSymbols: () => [],
    getBars,
    getSnapshot: () => {
      throw new Error('unused');
    },
    ...overrides,
  };
  return engine;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = async <T>(a: FastifyInstance, url: string) => {
  const res = await a.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json<ApiResult<T>>() };
};

describe('GET /api/capabilities', () => {
  it('publishes the engine timeframes, its delayed flag and the provider label', async () => {
    app = buildServer({ engine: eodEngine(), provider: 'fmp' });
    const { status, body } = await get(app, '/api/capabilities');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { timeframes: ['1D', '1W'], delayed: true, provider: 'fmp', fundamentals: false } });
  });

  it('lists a full-featured engine in canonical order, whatever order the engine declared', async () => {
    app = buildServer({ engine: eodEngine({ supportedTimeframes: [...TIMEFRAMES].reverse(), delayed: false }) });
    const { body } = await get(app, '/api/capabilities');
    expect(body).toEqual({ ok: true, data: { timeframes: [...TIMEFRAMES], delayed: false, provider: 'custom', fundamentals: false } });
  });

  it('reads delayed from the engine rather than a literal', async () => {
    app = buildServer({ engine: eodEngine({ delayed: false }) });
    const { body } = await get<{ delayed: boolean }>(app, '/api/capabilities');
    expect(body.ok && body.data.delayed).toBe(false);
  });

  it('carries nothing but the four contract fields', async () => {
    app = buildServer({ engine: eodEngine(), provider: 'fmp' });
    const { body } = await get<Record<string, unknown>>(app, '/api/capabilities');
    expect(body.ok && Object.keys(body.data).sort()).toEqual(['delayed', 'fundamentals', 'provider', 'timeframes']);
  });
});

describe('a timeframe the engine does not serve', () => {
  it.each<Timeframe>(['1m', '5m', '15m', '1h'])('%s is UNAUTHORIZED (500) and never reaches the engine', async (tf) => {
    const engine = eodEngine();
    app = buildServer({ engine, now: () => NOW });
    const { status, body } = await get(app, `/api/bars?symbol=AAPL&timeframe=${tf}&from=${NOW - DAY}&to=${NOW}`);
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(engine.getBars).not.toHaveBeenCalled();
  });

  it('is checked before the symbol, so an unknown symbol on an unsupported timeframe is still UNAUTHORIZED', async () => {
    app = buildServer({ engine: eodEngine(), now: () => NOW });
    const { body } = await get(app, `/api/bars?symbol=NOPE&timeframe=5m&from=${NOW - DAY}&to=${NOW}`);
    expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('the indicator oracle is guarded the same way', async () => {
    app = buildServer({ engine: eodEngine(), now: () => NOW });
    const { body } = await get(app, `/api/indicator?symbol=AAPL&timeframe=1m&from=${NOW - DAY}&to=${NOW}&kind=sma&period=3`);
    expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('a supported timeframe still works', async () => {
    app = buildServer({ engine: eodEngine(), now: () => NOW });
    const { status, body } = await get<BarsResponse>(app, `/api/bars?symbol=aapl&timeframe=1D&from=${NOW - 5 * DAY}&to=${NOW}`);
    expect(status).toBe(200);
    expect(body.ok && body.data.bars).toHaveLength(2);
  });
});

describe('an engine with no minute data and the forming bar (guarantee 5a)', () => {
  it("returns the provider's newest bar as reported instead of failing on a 1m rebuild", async () => {
    const engine = eodEngine();
    app = buildServer({ engine, now: () => NOW });
    const { status, body } = await get<BarsResponse>(app, `/api/bars?symbol=AAPL&timeframe=1D&from=${NOW - 5 * DAY}&to=${NOW}`);
    expect(status).toBe(200);
    expect(body.ok && body.data.bars.at(-1)?.time).toBe(Math.floor(NOW / DAY) * DAY);
    // One call for the range; none asking for minutes.
    expect(engine.getBars.mock.calls.map(([r]) => r.timeframe)).toEqual(['1D']);
  });
});

describe('an engine that refuses a request as unsupported', () => {
  it('maps to BAD_REQUEST (400) with a constant message', async () => {
    const engine = {
      ...eodEngine(),
      getBars: (): never => {
        throw new UnsupportedRequestError();
      },
    };
    app = buildServer({ engine, now: () => NOW });
    const { status, body } = await get(app, `/api/bars?symbol=AAPL&timeframe=1D&from=${NOW - DAY}&to=${NOW}&adjusted=false`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
});

describe('GET /api/capabilities — fundamentals flag (Phase 5)', () => {
  it('reports fundamentals: true when an available provider is wired in', async () => {
    const app = buildServer({
      engine: eodEngine(),
      provider: 'fmp',
      fundamentals: { available: true, getOverview: vi.fn(), getStatements: vi.fn(), getEarnings: vi.fn(), getNews: vi.fn() },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/capabilities' })).json();
    expect(body.ok && body.data.fundamentals).toBe(true);
    await app.close();
  });
});
