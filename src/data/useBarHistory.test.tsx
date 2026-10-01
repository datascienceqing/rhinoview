import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import type { Timeframe } from '@shared/types';
import { server } from '../../mocks/server';
import { MOCK_SYMBOLS } from '../../mocks/data';
import { parseBarsQuery } from '../../mocks/handlers';
import { DataSourceProvider } from './DataSourceContext';
import { HttpDataSource } from './HttpDataSource';
import { fetchBackwards, useBarHistory } from './useBarHistory';

// 2026-10-01: after the end of the fixtures, so "the last 180 days" has data.
const NOW = new Date('2026-10-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <DataSourceProvider value={new HttpDataSource()}>{children}</DataSourceProvider>
);

function render(symbol: string, timeframe: Timeframe) {
  return renderHook(({ s, t }) => useBarHistory(s, t), {
    wrapper,
    initialProps: { s: symbol, t: timeframe },
  });
}

describe('fetchBackwards near the epoch', () => {
  const calls: { from: number; to: number }[] = [];
  const ds = {
    searchSymbols: () => Promise.reject(new Error('unused')),
    getSnapshot: () => Promise.reject(new Error('unused')),
    getBars: (q: { from: number; to: number }) => {
      calls.push({ from: q.from, to: q.to });
      return Promise.resolve({ symbol: 'AAPL', timeframe: '1W' as const, adjusted: true, bars: [], truncated: false, cached: false });
    },
  };
  beforeEach(() => calls.splice(0));
  const signal = new AbortController().signal;

  it('floors from at 0 and stops once a window reaches 0 (no negative from, no further probes)', async () => {
    const chunk = await fetchBackwards(ds, { symbol: 'AAPL', timeframe: '1W' }, 1_000_000, signal);
    expect(chunk).toMatchObject({ bars: [], exhausted: true });
    expect(calls).toEqual([{ from: 0, to: 1_000_000 }]);
  });

  it('keeps widening while from stays positive, then clamps the last window to 0', async () => {
    const chunk = await fetchBackwards(ds, { symbol: 'AAPL', timeframe: '1D' }, 400 * 86_400, signal);
    expect(chunk.exhausted).toBe(true);
    expect(calls.every((c) => c.from >= 0 && c.to >= c.from)).toBe(true);
    expect(calls.at(-1)?.from).toBe(0);
  });

  it('does not ask at all when asked to go before the epoch', async () => {
    const chunk = await fetchBackwards(ds, { symbol: 'AAPL', timeframe: '1D' }, -1, signal);
    expect(chunk.exhausted).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('useBarHistory', () => {
  it('loads the initial window and becomes ready with ascending bars', async () => {
    const { result } = render('AAPL', '1D');
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const times = result.current.bars.map((b) => b.time);
    expect(times.length).toBeGreaterThan(50);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('prepends older bars on loadOlder and keeps the list strictly increasing', async () => {
    const { result } = render('AAPL', '1D');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = result.current.bars;
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.bars.length).toBeGreaterThan(before.length));
    const times = result.current.bars.map((b) => b.time);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(result.current.bars.slice(-before.length)).toEqual(before);
  });

  it('does not issue concurrent duplicate requests for older history', async () => {
    const { result } = render('AAPL', '1D');
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const requests: URL[] = [];
    server.use(
      http.get('*/api/bars', async ({ request }) => {
        const query = parseBarsQuery(request); // same bounds as the real schema
        if (!query.ok) return query.response;
        requests.push(new URL(request.url));
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ ok: true, data: { symbol: 'AAPL', timeframe: '1D', adjusted: true, bars: [], truncated: false, cached: false } });
      }),
    );

    act(() => {
      result.current.loadOlder();
      result.current.loadOlder();
      result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    // One logical load = 1 request + up to 3 widening probes, but never three parallel loads.
    const firstWindowRequests = requests.filter((u) => u.searchParams.get('to') === requests[0]?.searchParams.get('to'));
    expect(firstWindowRequests).toHaveLength(1);
  });

  it('stops asking once several consecutive windows are empty (exhausted)', async () => {
    const { result } = render('AAPL', '1D');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Walk back through all fixture history.
    for (let i = 0; i < 6 && !result.current.exhausted; i++) {
      act(() => result.current.loadOlder());
      await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    }
    expect(result.current.exhausted).toBe(true);

    let calls = 0;
    server.use(
      http.get('*/api/bars', ({ request }) => {
        const query = parseBarsQuery(request);
        if (!query.ok) return query.response;
        calls++;
        return HttpResponse.json({ ok: true, data: { bars: [] } });
      }),
    );
    act(() => result.current.loadOlder());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
  });

  it('refetches when the timeframe changes and shows only the new timeframe', async () => {
    const requests: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      const u = new URL(request.url);
      if (u.pathname === '/api/bars') requests.push(u);
    });
    const { result, rerender } = render('AAPL', '1D');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const daily = result.current.bars;

    rerender({ s: 'AAPL', t: '5m' });
    expect(result.current.status).toBe('loading');
    expect(result.current.bars).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(requests.some((u) => u.searchParams.get('timeframe') === '5m')).toBe(true);
    expect(result.current.bars).not.toEqual(daily);
    expect(result.current.bars.length).toBeGreaterThan(0);
    server.events.removeAllListeners();
  });

  it('never lets a slow response for the previous timeframe overwrite the current one', async () => {
    server.use(
      http.get('*/api/bars', async ({ request }) => {
        const query = parseBarsQuery(request);
        if (!query.ok) return query.response;
        const params = new URL(request.url).searchParams;
        const tf = params.get('timeframe');
        // 1D is slow, 5m is fast: the 1D response arrives AFTER the 5m one.
        await new Promise((r) => setTimeout(r, tf === '1D' ? 120 : 5));
        const bar = { time: tf === '1D' ? 1000 : 2000, open: 1, high: 1, low: 1, close: 1, volume: 1, vwap: null, transactions: null };
        return HttpResponse.json({
          ok: true,
          data: { symbol: 'AAPL', timeframe: tf, adjusted: true, bars: [bar], truncated: false, cached: false },
        });
      }),
    );
    const { result, rerender } = render('AAPL', '1D');
    rerender({ s: 'AAPL', t: '5m' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await new Promise((r) => setTimeout(r, 200)); // let the slow 1D response land
    expect(result.current.bars.map((b) => b.time)).toEqual([2000]);
  });

  it('surfaces a typed error for the initial load and recovers on reload', async () => {
    const { result } = render(MOCK_SYMBOLS.rateLimited, '1D');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('RATE_LIMITED');
    expect(result.current.error?.retryAfterSeconds).toBeGreaterThan(0);

    server.use(
      http.get('*/api/bars', ({ request }) => {
        const query = parseBarsQuery(request);
        if (!query.ok) return query.response;
        return HttpResponse.json({ ok: true, data: { symbol: 'LIMIT', timeframe: '1D', adjusted: true, bars: [], truncated: false, cached: false } });
      }),
    );
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('reports UNKNOWN_SYMBOL for an unknown symbol', async () => {
    const { result } = render('NOPE', '1D');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('UNKNOWN_SYMBOL');
  });

  it('keeps existing bars and blocks auto-retry when older history fails, until retryOlder', async () => {
    const { result } = render('AAPL', '1D');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = result.current.bars;

    let calls = 0;
    server.use(
      http.get('*/api/bars', ({ request }) => {
        const query = parseBarsQuery(request);
        if (!query.ok) return query.response;
        calls++;
        return HttpResponse.json({ ok: false, error: { code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 3 } }, { status: 429 });
      }),
    );
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderError?.code).toBe('RATE_LIMITED'));
    expect(result.current.bars).toBe(before);
    expect(result.current.status).toBe('ready');

    act(() => result.current.loadOlder());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);

    act(() => result.current.retryOlder());
    await waitFor(() => expect(calls).toBe(2));
  });

  it.each(['1D', '1W', '5m', '1h'] as const)(
    'walking %s history back to its start never sends a negative from, and ends exhausted without an error',
    async (timeframe) => {
      const froms: number[] = [];
      server.events.on('request:start', ({ request }) => {
        const u = new URL(request.url);
        if (u.pathname === '/api/bars') froms.push(Number(u.searchParams.get('from')));
      });
      const { result } = render('AAPL', timeframe);
      await waitFor(() => expect(result.current.status).toBe('ready'));
      for (let i = 0; i < 40 && !result.current.exhausted; i++) {
        act(() => result.current.loadOlder());
        await waitFor(() => expect(result.current.loadingOlder).toBe(false));
      }
      expect(result.current.exhausted).toBe(true);
      expect(result.current.olderError).toBeNull(); // the strict mock would 400 a negative from
      expect(froms.length).toBeGreaterThan(1);
      expect(Math.min(...froms)).toBeGreaterThanOrEqual(0);
    },
  );

  it('reports an empty initial window as ready with no bars (after widening)', async () => {
    const { result } = render('AAPL', '1m'); // the mocks have no 1m data
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.bars).toEqual([]);
    expect(result.current.exhausted).toBe(true);
  });
});
