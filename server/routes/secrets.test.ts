/**
 * No response body may contain the configured API key, a raw upstream URL, or a stack.
 * The key is installed before `env.ts` is first imported (it validates at import time).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TIMEFRAMES } from '@shared/types';
import type { Bar, Snapshot } from '@shared/types';

const API_KEY = vi.hoisted(() => {
  const key = 'sk-test-SECRET-KEY-9f8e7d6c';
  process.env.MASSIVE_API_KEY = key;
  return key;
});

const LEAKY = `request to https://api.massive.com/v2/aggs/ticker/AAPL?apiKey=${API_KEY} failed`;

let buildServer: typeof import('../index').buildServer;
let UnknownSymbolError: typeof import('../market/types').UnknownSymbolError;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  ({ buildServer } = await import('../index'));
  ({ UnknownSymbolError } = await import('../market/types'));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function leakyEngine() {
  const leak = (): never => {
    const err = new Error(LEAKY);
    err.stack = `Error: ${LEAKY}\n    at fetchUpstream (/srv/app/server/massive/client.ts:42:11)`;
    throw err;
  };
  return {
    supportedTimeframes: TIMEFRAMES,
    delayed: false,
    resolveSymbol: (s: string) =>
      s === 'AAPL' ? { symbol: 'AAPL', name: 'Apple', exchange: 'XNAS', type: 'CS', currency: 'USD', listedAt: 0 } : undefined,
    searchSymbols: leak,
    getBars: (): { bars: Bar[]; truncated: boolean } => leak(),
    getSnapshot: (): Snapshot => leak(),
  };
}

describe('error responses never leak internals', () => {
  it('runs with the key configured (sanity: the redaction under test is live)', async () => {
    const { redact } = await import('../env');
    expect(redact(LEAKY)).not.toContain(API_KEY);
  });

  it.each([
    ['bars', '/api/bars?symbol=AAPL&timeframe=1D&from=1700000000&to=1700086400'],
    ['snapshot', '/api/snapshot?symbol=AAPL'],
    ['search', '/api/search?q=a'],
    ['indicator', '/api/indicator?symbol=AAPL&timeframe=1D&from=1700000000&to=1700086400&kind=sma&period=3'],
  ])('upstream failure on %s: no key, URL, host or stack in the body', async (_name, url) => {
    app = buildServer({ engine: leakyEngine() });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(502);
    for (const needle of [API_KEY, 'apiKey', 'massive.com', 'https://', 'fetchUpstream', '/srv/app', 'at ']) {
      expect(res.body, `body must not contain "${needle}"`).not.toContain(needle);
    }
  });

  it('validation and unknown-symbol errors never contain the key either', async () => {
    app = buildServer({ engine: leakyEngine() });
    for (const url of [
      '/api/bars?symbol=AAPL&timeframe=nope&from=1&to=2',
      '/api/bars?symbol=NOPE&timeframe=1D&from=1700000000&to=1700086400',
      `/api/search?q=${API_KEY.slice(0, 20)}`.slice(0, 40),
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain(API_KEY);
    }
  });

  it('an UnknownSymbolError carrying the key in its text is not echoed', async () => {
    const engine = { ...leakyEngine(), getBars: (): never => { throw new UnknownSymbolError(API_KEY); } };
    app = buildServer({ engine });
    const res = await app.inject({ method: 'GET', url: '/api/bars?symbol=AAPL&timeframe=1D&from=1700000000&to=1700086400' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(API_KEY);
  });
});
