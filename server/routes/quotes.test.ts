/**
 * `GET /api/quotes` end to end through Fastify, against a fake engine. No network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiResult, QuotesResponse, Snapshot } from '@shared/types';
import { buildServer } from '../index';
import { UnknownSymbolError } from '../market/types';
import type { EngineSymbol, MarketEngine } from '../market/types';
import { RateLimitedError } from '../provider/errors';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sym = (symbol: string): EngineSymbol => ({ symbol, name: symbol, exchange: 'NASDAQ', type: 'CS', currency: 'USD', listedAt: 0 });
const snap = (symbol: string): Snapshot => ({ symbol, price: 10, change: 1, changePercent: 0.1, previousClose: 9, dayOpen: 9, dayHigh: 11, dayLow: 8, dayVolume: 100, updated: 1, delayed: true });
const KNOWN = new Set(['AAPL', 'MSFT', 'NVDA', 'LIMITED']);

function engine(getSnapshot?: MarketEngine['getSnapshot']) {
  const snapshot = vi.fn<MarketEngine['getSnapshot']>(
    getSnapshot ??
      ((s) => {
        if (s === 'LIMITED') throw new RateLimitedError(9);
        return snap(s);
      }),
  );
  const e: MarketEngine = {
    supportedTimeframes: ['1D'],
    delayed: true,
    resolveSymbol: (s) => (KNOWN.has(s.toUpperCase()) ? sym(s.toUpperCase()) : undefined),
    searchSymbols: () => [],
    getBars: () => ({ bars: [], truncated: false }),
    getSnapshot: snapshot,
  };
  return { e, snapshot };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function get(e: MarketEngine, query: string) {
  app = buildServer({ engine: e });
  const res = await app.inject({ method: 'GET', url: `/api/quotes${query}` });
  return { status: res.statusCode, body: res.json<ApiResult<QuotesResponse>>() };
}

describe('GET /api/quotes', () => {
  it('serves quotes in request order with canonical symbols, de-duplicated', async () => {
    const { e, snapshot } = engine();
    const { status, body } = await get(e, '?symbols=msft,AAPL,Msft,nvda');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { quotes: [snap('MSFT'), snap('AAPL'), snap('NVDA')], missing: [], failed: [] } });
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('partial success: missing as spelled, failed for a transient error, still HTTP 200', async () => {
    const { status, body } = await get(engine().e, '?symbols=AAPL,zzzz,LIMITED');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, data: { missing: ['zzzz'], failed: ['LIMITED'] } });
    expect(body.ok && body.data.quotes.map((q) => q.symbol)).toEqual(['AAPL']);
  });

  it('every symbol failed: error envelope with the first error code and Retry-After', async () => {
    app = buildServer({ engine: engine().e });
    const res = await app.inject({ method: 'GET', url: '/api/quotes?symbols=LIMITED' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('9');
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfterSeconds: 9 } });
  });

  it('shares the 15 s cache across requests on one server', async () => {
    const { e, snapshot } = engine();
    app = buildServer({ engine: e });
    await app.inject({ method: 'GET', url: '/api/quotes?symbols=AAPL,MSFT' });
    await app.inject({ method: 'GET', url: '/api/quotes?symbols=MSFT,aapl' });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const { e, snapshot } = engine();
    app = buildServer({ engine: e });
    await app.inject({ method: 'GET', url: '/api/quotes?symbols=AAPL,LIMITED' });
    await app.inject({ method: 'GET', url: '/api/quotes?symbols=AAPL,LIMITED' });
    expect(snapshot.mock.calls.filter((c) => c[0] === 'LIMITED')).toHaveLength(2);
    expect(snapshot.mock.calls.filter((c) => c[0] === 'AAPL')).toHaveLength(1);
  });

  it('maps an engine UnknownSymbolError at snapshot time to missing', async () => {
    const { e } = engine((s) => {
      throw new UnknownSymbolError(s);
    });
    const { body } = await get(e, '?symbols=AAPL');
    expect(body).toEqual({ ok: true, data: { quotes: [], missing: ['AAPL'], failed: [] } });
  });

  const fifty = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`).join(',');
  it.each([
    ['no symbols param', ''],
    ['empty symbols', '?symbols='],
    ['an empty entry', '?symbols=AAPL,,MSFT'],
    ['a 17-character entry', `?symbols=${'A'.repeat(17)}`],
    ['an entry with illegal characters', '?symbols=AA%20PL'],
    ['51 entries', `?symbols=${fifty(51)}`],
    ['a repeated parameter', '?symbols=AAPL&symbols=MSFT'],
  ])('answers BAD_REQUEST for %s, without calling the engine', async (_name, query) => {
    const { e, snapshot } = engine();
    const { status, body } = await get(e, query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 symbols', async () => {
    const { status, body } = await get(engine().e, `?symbols=${fifty(50)}`);
    expect(status).toBe(200);
    // None of S0..S49 is known to the fake engine: all missing, which is still success.
    expect(body.ok && body.data.missing).toHaveLength(50);
  });
});

describe('the comma-list trap', () => {
  it('is why this route fans out: the recorded comma-list answer is HTTP 200 with an empty array', () => {
    const f = JSON.parse(readFileSync(fileURLToPath(new URL('../market/fmp/__fixtures__/phase5/quote-comma-list-TRAP.json', import.meta.url)), 'utf8')) as { status: number; body: unknown[] };
    expect(f.status).toBe(200);
    expect(f.body).toEqual([]);
  });
});
