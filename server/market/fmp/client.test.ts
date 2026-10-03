import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError, UpstreamTimeoutError, UpstreamUnauthorizedError, mapEngineError } from '../../provider/errors';
import { FmpClient, FmpPaymentRequiredError, FmpUpstreamError } from './client';
import { TEST_KEY, fakeFetch, loadFixture, responseOf } from './testing';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function build(handler: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof FmpClient>[0]> = {}) {
  const fetch = fakeFetch(handler);
  const sleeps: number[] = [];
  const warns: unknown[][] = [];
  const client = new FmpClient({
    apiKey: TEST_KEY,
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: { warn: (...args) => void warns.push(args) },
    ...extra,
  });
  return { client, fetch, sleeps, warns };
}

describe('request shape', () => {
  it('sends the key as the apikey query parameter and the caller params alongside it', async () => {
    const { client, fetch } = build(() => json([]));
    await client.getJson('/quote', { symbol: 'AAPL' });
    const url = fetch.calls[0] ?? new URL('http://missing.invalid');
    expect(url.origin + url.pathname).toBe('https://financialmodelingprep.com/stable/quote');
    expect(url.searchParams.get('symbol')).toBe('AAPL');
    expect(url.searchParams.get('apikey')).toBe(TEST_KEY);
  });

  it('refuses to be constructed without a key', () => {
    expect(() => new FmpClient({ apiKey: '' })).toThrow();
  });
});

describe('429 backoff', () => {
  it('retries a 429 with doubling delays and then succeeds', async () => {
    const { client, sleeps, fetch } = build((_u, n) => (n < 2 ? json({}, 429) : json([{ ok: 1 }])));
    await expect(client.getJson('/quote', { symbol: 'AAPL' })).resolves.toEqual([{ ok: 1 }]);
    expect(sleeps).toEqual([500, 1000]);
    expect(fetch.calls).toHaveLength(3);
  });

  it('gives up after maxRetries and reports RATE_LIMITED with a retry hint', async () => {
    const { client, sleeps, fetch } = build(() => json({}, 429));
    const err = await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(mapEngineError(err).code).toBe('RATE_LIMITED');
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(fetch.calls).toHaveLength(4);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('honours Retry-After when FMP sends one, capped at 30 s', async () => {
    const { client, sleeps } = build((_u, n) => (n === 0 ? json({}, 429, { 'retry-after': '7' }) : n === 1 ? json({}, 429, { 'retry-after': '999' }) : json([])));
    await client.getJson('/quote', { symbol: 'AAPL' });
    expect(sleeps).toEqual([7000, 30000]);
  });

  it('does not retry anything but 429', async () => {
    for (const status of [401, 402, 403, 500, 503]) {
      const { client, fetch } = build(() => new Response('x', { status }));
      await client.getJson('/quote', { symbol: 'AAPL' }).catch(() => undefined);
      expect(fetch.calls, `status ${status}`).toHaveLength(1);
    }
  });
});

describe('upstream status mapping', () => {
  it('402 on a restricted endpoint (the recorded body) is a plan-tier failure -> UNAUTHORIZED', async () => {
    const { client } = build(() => responseOf(loadFixture('intraday-402')));
    const err = await client.getJson('/historical-chart/5min', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FmpPaymentRequiredError);
    expect(err).toBeInstanceOf(UpstreamUnauthorizedError);
    expect((err as FmpPaymentRequiredError).scope).toBe('endpoint');
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });

  it('402 on a restricted/unknown symbol (the recorded body) is told apart by scope', async () => {
    const { client } = build(() => responseOf(loadFixture('eod-unknown')));
    const err = await client.getJson('/profile', { symbol: 'ZZZZNOPE' }).catch((e: unknown) => e);
    expect((err as FmpPaymentRequiredError).scope).toBe('symbol');
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });

  it.each([401, 403])('%i is UNAUTHORIZED', async (status) => {
    const { client } = build(() => new Response('{}', { status }));
    const err = await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });

  it.each([500, 502, 503, 404])('%i is UPSTREAM_ERROR', async (status) => {
    const { client } = build(() => new Response('oops', { status }));
    const err = await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FmpUpstreamError);
    expect(mapEngineError(err).code).toBe('UPSTREAM_ERROR');
  });

  it('an unparseable 200 body is UPSTREAM_ERROR', async () => {
    const { client } = build(() => new Response('<html>nope</html>', { status: 200 }));
    const err = await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(mapEngineError(err).code).toBe('UPSTREAM_ERROR');
  });

  it('a 200 carrying {"Error Message": ...} is UPSTREAM_ERROR and the text is not forwarded', async () => {
    const { client } = build(() => json({ 'Error Message': 'Invalid something with apikey=abc' }));
    const err = (await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e)) as Error;
    expect(mapEngineError(err).code).toBe('UPSTREAM_ERROR');
    expect(err.message).not.toContain('Invalid something');
  });

  it('a timeout is UPSTREAM_TIMEOUT', async () => {
    const { client } = build(() => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })));
    const err = await client.getJson('/quote', { symbol: 'AAPL' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(mapEngineError(err).code).toBe('UPSTREAM_TIMEOUT');
  });

  it('passes an AbortSignal so a hung upstream cannot hang the proxy', async () => {
    let signal: AbortSignal | undefined;
    const client = new FmpClient({
      apiKey: TEST_KEY,
      fetch: (_u, init) => {
        signal = init.signal;
        return Promise.resolve(json([]));
      },
    });
    await client.getJson('/quote', {});
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * The key rides in the URL, so the failure modes most likely to leak it are exactly the
 * ones where something echoes that URL: a network error from undici, an upstream body
 * that quotes the request, a stack trace. Every one is exercised here.
 */
describe('the API key never escapes', () => {
  const echoesUrl = (url: URL) => `connect ECONNREFUSED ${url.href}`;

  const scenarios: [string, Parameters<typeof fakeFetch>[0]][] = [
    ['network error whose message embeds the URL', (u) => Promise.reject(new TypeError(`fetch failed: ${echoesUrl(u)}`))],
    ['402 body that quotes the key', () => new Response(`Premium Query Parameter: 'symbol' ... ?apikey=${TEST_KEY}`, { status: 402 })],
    ['500 body that quotes the key', () => new Response(`internal error for apikey=${TEST_KEY}`, { status: 500 })],
    ['401 body that quotes the key', () => new Response(`bad key ${TEST_KEY}`, { status: 401 })],
    ['200 error object quoting the key', () => json({ 'Error Message': `bad key ${TEST_KEY}` })],
    ['429 forever', () => json({ note: TEST_KEY }, 429)],
    ['unparseable 200 quoting the key', () => new Response(`not json ${TEST_KEY}`, { status: 200 })],
  ];

  it.each(scenarios)('%s', async (_name, handler) => {
    const { client, warns } = build(handler);
    const err = (await client.getJson('/historical-price-eod/full', { symbol: 'AAPL' }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);

    const mapped = mapEngineError(err);
    const surfaces = [
      err.message,
      err.stack ?? '',
      String(err),
      JSON.stringify(err, Object.getOwnPropertyNames(err)),
      JSON.stringify(mapped.toApiError()),
      JSON.stringify(warns),
    ];
    for (const s of surfaces) {
      expect(s).not.toContain(TEST_KEY);
      expect(s).not.toContain(encodeURIComponent(TEST_KEY));
      expect(s).not.toContain('apikey');
    }
  });

  it('scrub() removes the key in raw and URL-encoded form', () => {
    const odd = 'a+b/c=d&e';
    const client = new FmpClient({ apiKey: odd });
    const text = `x ${odd} y ${encodeURIComponent(odd)} z`;
    expect(client.scrub(text)).toBe('x [REDACTED] y [REDACTED] z');
  });

  it('the recorded fixtures were scrubbed: none contains an apikey', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(dir + f, 'utf8').toLowerCase(), f).not.toMatch(/apikey|api_key/);
  });

  it('logs only the path and status on upstream errors, never a URL', async () => {
    const { client, warns } = build(() => new Response('x', { status: 503 }));
    await client.getJson('/quote', { symbol: 'AAPL' }).catch(() => undefined);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toMatch(/https?:|financialmodelingprep|symbol=/);
  });
});

vi.setConfig({ testTimeout: 5000 });
