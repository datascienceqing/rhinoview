import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { DataError, isDataError } from './errors';
import { HttpDataSource } from './HttpDataSource';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function rejection(p: Promise<unknown>): Promise<DataError> {
  try {
    await p;
  } catch (e) {
    if (isDataError(e)) return e;
    throw e;
  }
  throw new Error('expected the promise to reject');
}

describe('HttpDataSource envelope handling', () => {
  it('unwraps ok:true envelopes to their data', async () => {
    const ds = new HttpDataSource({ fetch: async () => json({ ok: true, data: { query: 'a', results: [] } }) });
    await expect(ds.searchSymbols('a')).resolves.toEqual({ query: 'a', results: [] });
  });

  it.each([
    ['UNKNOWN_SYMBOL', 404],
    ['BAD_REQUEST', 400],
    ['UPSTREAM_ERROR', 502],
    ['UPSTREAM_TIMEOUT', 504],
    ['UNAUTHORIZED', 500],
    ['INTERNAL', 500],
  ] as const)('turns an ok:false %s envelope into a DataError carrying that code', async (code, status) => {
    const ds = new HttpDataSource({
      fetch: async () => json({ ok: false, error: { code, message: 'whatever the server says' } }, status),
    });
    const err = await rejection(ds.getSnapshot('AAPL'));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('carries retryAfterSeconds on RATE_LIMITED', async () => {
    const ds = new HttpDataSource({
      fetch: async () =>
        json({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 12 } }, 429),
    });
    const err = await rejection(ds.getSnapshot('AAPL'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('maps a code it does not know to INTERNAL rather than leaking an unbranchable string', async () => {
    const ds = new HttpDataSource({
      fetch: async () => json({ ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } }, 500),
    });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('INTERNAL');
  });

  it('does not depend on error.message text', async () => {
    const make = (message: string) =>
      new HttpDataSource({ fetch: async () => json({ ok: false, error: { code: 'UNKNOWN_SYMBOL', message } }, 404) });
    const a = await rejection(make('not found').getSnapshot('X'));
    const b = await rejection(make('completely different words').getSnapshot('X'));
    expect(a.code).toBe(b.code);
  });
});

describe('HttpDataSource non-contract failures', () => {
  it('reports NETWORK when fetch itself rejects', async () => {
    const ds = new HttpDataSource({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('NETWORK');
  });

  it('maps an HTML 502 (dev proxy with the backend down) to UPSTREAM_ERROR', async () => {
    const ds = new HttpDataSource({
      fetch: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('UPSTREAM_ERROR');
  });

  it('maps an HTML 504 to UPSTREAM_TIMEOUT', async () => {
    const ds = new HttpDataSource({ fetch: async () => new Response('timeout', { status: 504 }) });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('UPSTREAM_TIMEOUT');
  });

  it('maps a bare 429 to RATE_LIMITED and reads Retry-After', async () => {
    const ds = new HttpDataSource({
      fetch: async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
    });
    const err = await rejection(ds.getSnapshot('AAPL'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(7);
  });

  it('does NOT treat a bare 404 as UNKNOWN_SYMBOL (that would be a missing route)', async () => {
    const ds = new HttpDataSource({ fetch: async () => new Response('Not found', { status: 404 }) });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('BAD_RESPONSE');
  });

  it('reports BAD_RESPONSE for a 200 whose body is not JSON', async () => {
    const ds = new HttpDataSource({ fetch: async () => new Response('garbage', { status: 200 }) });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('BAD_RESPONSE');
  });

  it('reports BAD_RESPONSE for JSON that is not a contract envelope', async () => {
    const ds = new HttpDataSource({ fetch: async () => json({ hello: 'world' }) });
    expect((await rejection(ds.getSnapshot('AAPL'))).code).toBe('BAD_RESPONSE');
  });

  it('rejects with ABORTED without calling fetch when the signal is already aborted', async () => {
    const fetchSpy = vi.fn();
    const ds = new HttpDataSource({ fetch: fetchSpy });
    const controller = new AbortController();
    controller.abort();
    expect((await rejection(ds.getSnapshot('AAPL', { signal: controller.signal }))).code).toBe('ABORTED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects with ABORTED when aborted mid-flight', async () => {
    const ds = new HttpDataSource({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const controller = new AbortController();
    const pending = rejection(ds.getSnapshot('AAPL', { signal: controller.signal }));
    controller.abort();
    expect((await pending).code).toBe('ABORTED');
  });
});

describe('HttpDataSource requests', () => {
  it('sends bars params verbatim: symbol case preserved, times as given (seconds)', async () => {
    const seen: string[] = [];
    const ds = new HttpDataSource({
      fetch: async (url) => {
        seen.push(url);
        return json({ ok: true, data: { bars: [] } });
      },
    });
    await ds.getBars({ symbol: 'BRK.b', timeframe: '5m', from: 1790775000, to: 1790798100 });
    const url = new URL(seen[0] ?? '');
    expect(url.pathname).toBe('/api/bars');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BRK.b',
      timeframe: '5m',
      from: '1790775000',
      to: '1790798100',
    });
  });

  it('url-encodes the search query and forwards limit', async () => {
    const seen: string[] = [];
    const ds = new HttpDataSource({
      fetch: async (url) => {
        seen.push(url);
        return json({ ok: true, data: { query: 'a&b', results: [] } });
      },
    });
    await ds.searchSymbols('a&b c', { limit: 5 });
    const url = new URL(seen[0] ?? '');
    expect(url.searchParams.get('q')).toBe('a&b c');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('works through the global fetch against MSW (same-origin /api path)', async () => {
    const ds = new HttpDataSource();
    const snapshot = await ds.getSnapshot('AAPL');
    expect(snapshot.symbol).toBe('AAPL');
    expect(snapshot.delayed).toBe(true);
  });

  it('surfaces an MSW network error as NETWORK', async () => {
    server.use(http.get('*/api/snapshot', () => HttpResponse.error()));
    expect((await rejection(new HttpDataSource().getSnapshot('AAPL'))).code).toBe('NETWORK');
  });
});
