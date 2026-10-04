/**
 * Fundamentals routes: zod validation, error mapping, the envelope. Provider behaviour is
 * tested next to the providers; here the provider is a fake, a synthetic one, or the FMP
 * provider over recorded fixtures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiResult, Capabilities, EarningsResponse, FundamentalsOverview, StatementsResponse } from '@shared/types';
import { FmpPaymentRequiredError, FmpUpstreamError } from '../market/fmp/client';
import { createFixtureFundamentals } from '../fundamentals/fmp/fixtureSource';
import { SyntheticFundamentalsProvider } from '../fundamentals/synthetic/provider';
import type { FundamentalsProvider } from '../fundamentals/types';
import { UNAVAILABLE_FUNDAMENTALS } from '../fundamentals';
import { buildServer } from '../index';
import { createSyntheticEngine } from '../market';
import { UnknownSymbolError } from '../market/types';
import { RateLimitedError, UpstreamTimeoutError } from '../provider/errors';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function serve(fundamentals: FundamentalsProvider): FastifyInstance {
  app = buildServer({ engine: createSyntheticEngine(), fundamentals });
  return app;
}

async function get<T>(url: string): Promise<{ status: number; body: ApiResult<T>; headers: Record<string, unknown> }> {
  if (!app) throw new Error('no app');
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as ApiResult<T>, headers: res.headers };
}

function fake(overrides: Partial<FundamentalsProvider> = {}) {
  const provider = {
    available: true,
    getOverview: vi.fn(() => Promise.reject(new Error('unexpected'))),
    getStatements: vi.fn(() => Promise.reject(new Error('unexpected'))),
    getEarnings: vi.fn(() => Promise.reject(new Error('unexpected'))),
    ...overrides,
  } satisfies FundamentalsProvider;
  return provider;
}

describe('success', () => {
  it('serves the overview as an ok envelope', async () => {
    serve(new SyntheticFundamentalsProvider());
    const { status, body } = await get<FundamentalsOverview>('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.data.profile.symbol).toBe('AAPL');
      expect(body.data.unavailable).toEqual([]);
    }
  });

  it('serves statements for every kind and period', async () => {
    serve(new SyntheticFundamentalsProvider());
    for (const statement of ['income', 'balance', 'cashflow']) {
      for (const period of ['annual', 'quarter']) {
        const { status, body } = await get<StatementsResponse>(`/api/fundamentals/statements?symbol=MSFT&statement=${statement}&period=${period}`);
        expect(status).toBe(200);
        if (body.ok) expect(body.data).toMatchObject({ symbol: 'MSFT', statement, period });
      }
    }
  });

  it('serves earnings', async () => {
    serve(new SyntheticFundamentalsProvider());
    const { body } = await get<EarningsResponse>('/api/fundamentals/earnings?symbol=AAPL');
    expect(body.ok && body.data.events.length).toBeGreaterThan(0);
  });

  it('passes the symbol to the provider trimmed, as the caller spelled it', async () => {
    const provider = fake({ getEarnings: vi.fn((s: string) => Promise.resolve({ symbol: s, events: [] })) });
    serve(provider);
    await get('/api/fundamentals/earnings?symbol=%20aapl%20');
    expect(provider.getEarnings).toHaveBeenCalledWith('aapl');
  });

  it('passes JPM gross margin 0.626 and RIVN negative P/E through the whole stack, from the FMP mapper', async () => {
    serve(createFixtureFundamentals());
    const jpm = await get<FundamentalsOverview>('/api/fundamentals/overview?symbol=JPM');
    const rivn = await get<FundamentalsOverview>('/api/fundamentals/overview?symbol=RIVN');
    expect(jpm.body.ok && jpm.body.data.metrics.grossMargin).toBeCloseTo(0.626, 3);
    expect(rivn.body.ok && rivn.body.data.metrics.peRatio).toBeCloseTo(-5.54, 2);
  });

  it('serves MSFT fiscal labels and TSM currency through the whole stack', async () => {
    serve(createFixtureFundamentals());
    const msft = await get<StatementsResponse>('/api/fundamentals/statements?symbol=MSFT&statement=income&period=quarter');
    const tsm = await get<StatementsResponse>('/api/fundamentals/statements?symbol=TSM&statement=income&period=annual');
    expect(msft.body.ok && msft.body.data.rows[0]).toMatchObject({ fiscalYear: 2026, fiscalPeriod: 'Q4' });
    expect(tsm.body.ok && tsm.body.data.rows[0]?.reportedCurrency).toBe('TWD');
  });
});

describe('validation — BAD_REQUEST, and the provider is not called', () => {
  const bad = [
    '/api/fundamentals/overview',
    '/api/fundamentals/overview?symbol=',
    '/api/fundamentals/overview?symbol=%20%20',
    `/api/fundamentals/overview?symbol=${'A'.repeat(17)}`,
    '/api/fundamentals/overview?symbol=AA%20PL',
    '/api/fundamentals/overview?symbol=AA%2FPL',
    `/api/fundamentals/overview?symbol=%5E${'A'.repeat(16)}`,
    '/api/fundamentals/overview?symbol=AAPL&symbol=MSFT',
    '/api/fundamentals/earnings',
    '/api/fundamentals/statements?symbol=AAPL',
    '/api/fundamentals/statements?symbol=AAPL&statement=income',
    '/api/fundamentals/statements?symbol=AAPL&period=annual',
    '/api/fundamentals/statements?symbol=AAPL&statement=ratios&period=annual',
    '/api/fundamentals/statements?symbol=AAPL&statement=income&period=ttm',
    '/api/fundamentals/statements?symbol=AAPL&statement=INCOME&period=annual',
  ];

  it.each(bad)('%s', async (url) => {
    const provider = fake();
    serve(provider);
    const { status, body } = await get(url);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(provider.getOverview).not.toHaveBeenCalled();
    expect(provider.getStatements).not.toHaveBeenCalled();
    expect(provider.getEarnings).not.toHaveBeenCalled();
  });

  it('names the offending parameter', async () => {
    serve(fake());
    const { body } = await get('/api/fundamentals/statements?symbol=AAPL&statement=ratios&period=annual');
    expect(!body.ok && body.error.message).toContain('"statement"');
  });

  it('accepts every symbol the workspace store accepts, including indexes, and answers UNKNOWN_SYMBOL when there are no fundamentals', async () => {
    serve(new SyntheticFundamentalsProvider());
    for (const sym of ['%5EGSPC', 'EURUSD%3DX', 'BRK-B']) {
      const { status, body } = await get(`/api/fundamentals/earnings?symbol=${sym}`);
      expect(status).toBe(404);
      expect(!body.ok && body.error.code).toBe('UNKNOWN_SYMBOL');
    }
    await app?.close();
    serve(createFixtureFundamentals()); // FMP path: empty profile
    const { status, body } = await get('/api/fundamentals/overview?symbol=%5EGSPC');
    expect(status).toBe(404);
    expect(!body.ok && body.error.code).toBe('UNKNOWN_SYMBOL');
  });

  it('accepts class-share tickers', async () => {
    serve(new SyntheticFundamentalsProvider());
    expect((await get('/api/fundamentals/overview?symbol=BRK.B')).status).toBe(200);
  });
});

describe('error mapping', () => {
  const failing = (err: unknown) => fake({ getOverview: vi.fn(() => Promise.reject(err)) });

  it('maps an unknown symbol to 404 UNKNOWN_SYMBOL', async () => {
    serve(new SyntheticFundamentalsProvider());
    const { status, body } = await get('/api/fundamentals/overview?symbol=ZZZZ');
    expect(status).toBe(404);
    expect(body).toMatchObject({ ok: false, error: { code: 'UNKNOWN_SYMBOL', message: 'Unknown symbol: ZZZZ' } });
  });

  it('maps an empty FMP profile to UNKNOWN_SYMBOL on all three routes', async () => {
    serve(createFixtureFundamentals());
    for (const url of [
      '/api/fundamentals/overview?symbol=NOPE',
      '/api/fundamentals/statements?symbol=NOPE&statement=income&period=annual',
      '/api/fundamentals/earnings?symbol=NOPE',
    ]) {
      const { status, body } = await get(url);
      expect(status).toBe(404);
      expect(!body.ok && body.error.code).toBe('UNKNOWN_SYMBOL');
    }
  });

  it('maps a plan-tier 402 to UNAUTHORIZED, not UNKNOWN_SYMBOL', async () => {
    serve(failing(new FmpPaymentRequiredError('symbol')));
    const { status, body } = await get('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(500); // contract: UNAUTHORIZED maps to HTTP 500
    expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('maps throttling to 429 RATE_LIMITED with Retry-After', async () => {
    serve(failing(new RateLimitedError(7)));
    const { status, body, headers } = await get('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(429);
    expect(body).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfterSeconds: 7 } });
    expect(headers['retry-after']).toBe('7');
  });

  it('maps a timeout to 504 UPSTREAM_TIMEOUT', async () => {
    serve(failing(new UpstreamTimeoutError()));
    const { status, body } = await get('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(504);
    expect(!body.ok && body.error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('maps any other provider failure to 502 UPSTREAM_ERROR with a constant message, never the raw text', async () => {
    serve(failing(new FmpUpstreamError('leaky detail apikey=SECRET-KEY-123')));
    const { status, body } = await get('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(502);
    expect(!body.ok && body.error.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/leaky|SECRET/);
  });

  it('maps a non-Error rejection the same way', async () => {
    serve(failing('plain string'));
    const { status } = await get('/api/fundamentals/overview?symbol=AAPL');
    expect(status).toBe(502);
  });

  it('maps errors on the statements and earnings routes too', async () => {
    serve(
      fake({
        getStatements: vi.fn(() => Promise.reject(new UnknownSymbolError('X'))),
        getEarnings: vi.fn(() => Promise.reject(new RateLimitedError(1))),
      }),
    );
    expect((await get('/api/fundamentals/statements?symbol=X&statement=income&period=annual')).status).toBe(404);
    expect((await get('/api/fundamentals/earnings?symbol=X')).status).toBe(429);
  });
});

describe('capabilities', () => {
  it('reports fundamentals true for a real provider and false for the unavailable one', async () => {
    serve(new SyntheticFundamentalsProvider());
    const on = await get<Capabilities>('/api/capabilities');
    expect(on.body.ok && on.body.data.fundamentals).toBe(true);
    await app?.close();
    serve(UNAVAILABLE_FUNDAMENTALS);
    const off = await get<Capabilities>('/api/capabilities');
    expect(off.body.ok && off.body.data.fundamentals).toBe(false);
  });
});
