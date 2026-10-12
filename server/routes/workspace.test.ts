/**
 * Workspace HTTP routes against a real store in a temp directory, plus a side-by-side
 * run against the MSW mock (mocks/workspace.ts) to keep the two answering alike.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiResult, ChartLayout, Watchlist, Workspace } from '@shared/types';
import { createWorkspaceHandlers, resetMockWorkspace } from '../../mocks/workspace';
import { buildServer } from '../index';
import type { MarketEngine } from '../market/types';
import { createWorkspaceStore } from '../workspace';

const engine: MarketEngine = {
  supportedTimeframes: ['1D'],
  delayed: false,
  resolveSymbol: () => undefined,
  searchSymbols: () => [],
  getBars: () => ({ bars: [], truncated: false }),
  getSnapshot: () => {
    throw new Error('unused');
  },
};

interface Reply {
  status: number;
  body: ApiResult<unknown>;
}
type Call = (method: string, path: string, body?: unknown) => Promise<Reply>;

let dir: string;
let app: FastifyInstance;
let call: Call;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rhinoview-ws-routes-'));
  const store = await createWorkspaceStore(join(dir, 'workspace.json'));
  app = buildServer({ engine, workspace: store });
  call = async (method, path, body) => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api${path}`,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: res.json() as ApiResult<unknown> };
  };
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const data = <T>(r: Reply): T => {
  if (!r.body.ok) throw new Error(`expected ok, got ${JSON.stringify(r.body.error)}`);
  return r.body.data as T;
};
const errCode = (r: Reply) => (r.body.ok ? 'ok' : r.body.error.code);

describe('workspace routes', () => {
  it('serves the default workspace', async () => {
    const r = await call('GET', '/workspace');
    expect(r.status).toBe(200);
    const ws = data<Workspace>(r);
    expect(ws.layouts[0]?.name).toBe('Main');
    expect(ws.watchlists[0]?.symbols).toEqual(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL']);
  });

  it('serves the layouts and watchlists views with their active ids', async () => {
    const ws = data<Workspace>(await call('GET', '/workspace'));
    expect(data(await call('GET', '/layouts'))).toEqual({ layouts: ws.layouts, activeLayoutId: ws.activeLayoutId });
    expect(data(await call('GET', '/watchlists'))).toEqual({ watchlists: ws.watchlists, activeWatchlistId: ws.activeWatchlistId });
  });

  it('answers POST with 201 and the new entity', async () => {
    const l = await call('POST', '/layouts', { name: 'Two', symbol: 'msft', indicators: [] });
    expect(l.status).toBe(201);
    expect(data<ChartLayout>(l)).toMatchObject({ name: 'Two', symbol: 'MSFT', revision: 1 });
    const w = await call('POST', '/watchlists', { name: 'W2', symbols: ['a', 'A', 'b'] });
    expect(w.status).toBe(201);
    expect(data<Watchlist>(w).symbols).toEqual(['A', 'B']);
  });

  it('updates with PUT and the right revision', async () => {
    const l = data<ChartLayout>(await call('POST', '/layouts', { name: 'Two' }));
    const r = await call('PUT', `/layouts/${l.id}`, { revision: 1, timeframe: '1W' });
    expect(r.status).toBe(200);
    expect(data<ChartLayout>(r)).toMatchObject({ timeframe: '1W', revision: 2 });
  });

  it('answers DELETE with the whole workspace', async () => {
    const l = data<ChartLayout>(await call('POST', '/layouts', { name: 'Two' }));
    const r = await call('DELETE', `/layouts/${l.id}`);
    expect(r.status).toBe(200);
    expect(data<Workspace>(r).layouts).toHaveLength(1);
  });

  it('maps a stale revision to 409 CONFLICT', async () => {
    const l = data<ChartLayout>(await call('POST', '/layouts', { name: 'Two' }));
    await call('PUT', `/layouts/${l.id}`, { revision: 1, chartType: 'line' });
    const r = await call('PUT', `/layouts/${l.id}`, { revision: 1, chartType: 'bar' });
    expect([r.status, errCode(r)]).toEqual([409, 'CONFLICT']);
  });

  it('maps unknown ids to 404 NOT_FOUND', async () => {
    for (const [m, p, b] of [
      ['PUT', '/layouts/nope', { revision: 1 }],
      ['DELETE', '/layouts/nope', undefined],
      ['PUT', '/watchlists/nope', { revision: 1 }],
      ['DELETE', '/watchlists/nope', undefined],
      ['PUT', '/workspace/active', { activeLayoutId: 'nope' }],
    ] as const) {
      const r = await call(m, p, b);
      expect([m, p, r.status, errCode(r)]).toEqual([m, p, 404, 'NOT_FOUND']);
    }
  });

  it('maps validation failures to 400 BAD_REQUEST with a readable message', async () => {
    const dup = await call('POST', '/layouts', { name: 'main' });
    expect([dup.status, errCode(dup)]).toEqual([400, 'BAD_REQUEST']);
    expect(!dup.body.ok && dup.body.error.message).toMatch(/already in use/);
    const ws = data<Workspace>(await call('GET', '/workspace'));
    const last = await call('DELETE', `/layouts/${ws.layouts[0]?.id}`);
    expect([last.status, errCode(last)]).toEqual([400, 'BAD_REQUEST']);
    const ind = await call('POST', '/layouts', {
      name: 'Bad', indicators: [{ id: 'a', kind: 'sma', params: { period: 0 }, color: '#fff', visible: true }],
    });
    expect([ind.status, errCode(ind)]).toEqual([400, 'BAD_REQUEST']);
    expect(!ind.body.ok && ind.body.error.message).toMatch(/period/);
  });

  it.each([
    ['an unknown field on create', 'POST', '/layouts', { name: 'X', colour: 'red' }],
    ['an unknown field on update', 'PUT', '/watchlists/ID', { revision: 1, extra: true }],
    ['an unknown field in an indicator', 'POST', '/layouts', { name: 'X', indicators: [{ id: 'a', kind: 'rsi', params: { period: 14 }, color: '#fff', visible: true, z: 1 }] }],
    ['an unknown indicator kind on create', 'POST', '/layouts', { name: 'X', indicators: [{ id: 'a', kind: 'bollinger', params: { period: 20 }, color: '#fff', visible: true }] }],
    ['an unknown indicator kind on update', 'PUT', '/layouts/ID', { revision: 1, indicators: [{ id: 'a', kind: 'bollinger', params: { period: 20 }, color: '#fff', visible: true }] }],
    ['an unknown field on set-active', 'PUT', '/workspace/active', { activeLayoutId: 'ID', foo: 1 }],
    ['a missing revision', 'PUT', '/layouts/ID', { name: 'X' }],
    ['a non-numeric revision', 'PUT', '/layouts/ID', { revision: '1' }],
    ['a wrong timeframe', 'POST', '/layouts', { name: 'X', timeframe: '2h' }],
    ['a missing name', 'POST', '/watchlists', {}],
    ['a non-string symbol', 'POST', '/watchlists', { name: 'X', symbols: [1] }],
  ])('rejects %s with 400 BAD_REQUEST', async (_label, method, path, body) => {
    const ws = data<Workspace>(await call('GET', '/workspace'));
    const id = method === 'PUT' && path.includes('watchlists') ? ws.watchlists[0]?.id : ws.layouts[0]?.id;
    const real = path.replace('ID', String(id));
    const b = JSON.parse(JSON.stringify(body).replace('"ID"', JSON.stringify(ws.layouts[0]?.id)));
    const r = await call(method, real, b);
    expect([r.status, errCode(r)]).toEqual([400, 'BAD_REQUEST']);
  });

  it('answers malformed JSON with a BAD_REQUEST envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: '{oops', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as ApiResult<unknown>).ok).toBe(false);
  });

  it('answers INTERNAL "not implemented" when no store is wired', async () => {
    const bare = buildServer({ engine });
    const res = await bare.inject({ url: '/api/workspace' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
    await bare.close();
  });

  it('keeps 20 parallel creates over HTTP', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/layouts', { name: `P${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(data<Workspace>(await call('GET', '/workspace')).layouts).toHaveLength(21);
  });

  it('keeps data across a restart on the same file', async () => {
    await call('POST', '/layouts', { name: 'Persisted' });
    const again = buildServer({ engine, workspace: await createWorkspaceStore(join(dir, 'workspace.json')) });
    const res = await again.inject({ url: '/api/layouts' });
    expect(JSON.stringify(res.json())).toContain('Persisted');
    await again.close();
  });
});

// ─────────────────────── The same sequence against the MSW mock ───────────────────────

describe('server and mock answer the same way', () => {
  const mockServer = setupServer(...createWorkspaceHandlers());
  beforeAll(() => mockServer.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => mockServer.close());
  beforeEach(() => resetMockWorkspace());

  const mockCall: Call = async (method, path, body) => {
    const res = await fetch(`http://mock.test/api${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    return { status: res.status, body: (await res.json()) as ApiResult<unknown> };
  };

  /** Run one scenario on both and compare status, ok, error code. Ids differ, so a step may use `ctx`. */
  interface Step { m: string; p: (ctx: Ctx) => string; b?: (ctx: Ctx) => unknown; save?: string; probe?: boolean }
  type Ctx = Record<string, string>;
  const shape = (r: Reply) => ({ status: r.status, ok: r.body.ok, code: r.body.ok ? null : r.body.error.code });

  async function run(c: Call, steps: Step[]) {
    const ctx: Ctx = {};
    const ws = data<Workspace>(await c('GET', '/workspace'));
    ctx.lay0 = ws.layouts[0]?.id as string;
    ctx.wl0 = ws.watchlists[0]?.id as string;
    const out = [];
    for (const s of steps) {
      const r = await c(s.m, s.p(ctx), s.b?.(ctx));
      out.push(s.probe && r.body.ok
        ? { ...shape(r), activeIsLay0: (r.body.data as Workspace).activeLayoutId === ctx.lay0 }
        : shape(r));
      if (s.save && r.body.ok) ctx[s.save] = (r.body.data as { id: string }).id;
    }
    return out;
  }

  const scenario = (name: string, steps: Step[]) =>
    it(name, async () => {
      const mine = await run(call, steps);
      const theirs = await run(mockCall, steps);
      expect(mine).toEqual(theirs);
    });

  scenario('conflict, not-found, last layout, duplicate name, limits of the body', [
    { m: 'PUT', p: (c) => `/layouts/${c.lay0}`, b: () => ({ revision: 1, timeframe: '1W' }) },
    { m: 'PUT', p: (c) => `/layouts/${c.lay0}`, b: () => ({ revision: 1, timeframe: '5m' }) }, // 409
    { m: 'PUT', p: () => '/layouts/nope', b: () => ({ revision: 1 }) }, // 404
    { m: 'DELETE', p: (c) => `/layouts/${c.lay0}` }, // last layout 400
    { m: 'DELETE', p: () => '/layouts/nope' }, // 404
    { m: 'POST', p: () => '/layouts', b: () => ({ name: ' MAIN ' }) }, // duplicate 400
    { m: 'POST', p: () => '/layouts', b: () => ({ name: '' }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'T', symbol: 'bad symbol' }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'T', timeframe: '2h' }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'Two' }), save: 'lay1' }, // 201
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ revision: 1, name: 'main' }) }, // rename onto another
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ name: 'No revision' }) }, // 400
    { m: 'PUT', p: () => '/workspace/active', b: (c) => ({ activeLayoutId: c.lay1 }) },
    { m: 'DELETE', p: (c) => `/layouts/${c.lay1}` }, // active deleted
    { m: 'PUT', p: () => '/workspace/active', b: () => ({ activeLayoutId: 'nope' }) },
    { m: 'PUT', p: () => '/workspace/active', b: () => ({ activeWatchlistId: null }) },
  ]);

  scenario('watchlists', [
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'Tech', symbols: ['msft', 'AAPL', 'MSFT'] }), save: 'wl1' },
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'tech' }) }, // duplicate
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'Big', symbols: Array.from({ length: 51 }, (_, i) => `S${i}`) }) },
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'Bad', symbols: ['no way'] }) },
    { m: 'PUT', p: (c) => `/watchlists/${c.wl1}`, b: () => ({ revision: 1, symbols: ['ibm'] }) },
    { m: 'PUT', p: (c) => `/watchlists/${c.wl1}`, b: () => ({ revision: 1, symbols: ['ibm'] }) }, // 409
    { m: 'PUT', p: () => '/watchlists/nope', b: () => ({ revision: 1 }) },
    { m: 'DELETE', p: (c) => `/watchlists/${c.wl1}` },
    { m: 'DELETE', p: (c) => `/watchlists/${c.wl0}` },
    { m: 'DELETE', p: (c) => `/watchlists/${c.wl0}` }, // 404 now
    { m: 'PUT', p: () => '/workspace/active', b: () => ({ activeWatchlistId: 'nope' }) },
  ]);

  const ind = (over: object) => ({ id: 'a', kind: 'sma', params: { period: 5 }, color: '#fff', visible: true, ...over });
  scenario('strict bodies, indicators, atomic active, bad revisions, body before id', [
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'Two' }), save: 'lay1' },
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'Wl2' }), save: 'wl1' },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'X', extra: 1 }) },
    { m: 'POST', p: () => '/watchlists', b: () => ({ name: 'X', extra: 1 }) },
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ revision: 1, extra: 1 }) },
    { m: 'PUT', p: (c) => `/watchlists/${c.wl1}`, b: () => ({ revision: 1, extra: 1 }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'I', indicators: [ind({ params: { period: 0 } })] }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'I', indicators: [ind({ params: { period: 501 } })] }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'I', indicators: [ind({ kind: 'macd', params: { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 } })] }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'I', indicators: [ind({ params: 'nope' })] }) },
    { m: 'POST', p: () => '/layouts', b: () => ({ name: 'I', indicators: [ind({}), ind({})] }) },
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ revision: 1, indicators: [ind({}), ind({})] }) },
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ revision: 1, indicators: [ind({})] }) },
    { m: 'PUT', p: () => '/workspace/active', b: (c) => ({ activeLayoutId: c.lay1, activeWatchlistId: 'nope' }) },
    { m: 'GET', p: () => '/workspace', probe: true },
    { m: 'PUT', p: () => '/workspace/active', b: () => ({ activeLayoutId: null }) },
    { m: 'GET', p: () => '/workspace', probe: true },
    { m: 'PUT', p: (c) => `/layouts/${c.lay1}`, b: () => ({ revision: 1.5 }) },
    { m: 'PUT', p: (c) => `/watchlists/${c.wl1}`, b: () => ({ revision: 1.5 }) },
    { m: 'PUT', p: () => '/layouts/nope', b: () => ({ revision: 'x' }) },
    { m: 'PUT', p: () => '/layouts/nope', b: () => ({ name: 5 }) },
    { m: 'PUT', p: () => '/watchlists/nope', b: () => ({ extra: 1 }) },
    { m: 'PUT', p: () => '/layouts/nope', b: () => ({ revision: 1 }) },
  ]);

  it('agree on the final workspace shape after a mixed sequence (ids and times aside)', async () => {
    const steps = async (c: Call) => {
      await c('POST', '/layouts', { name: 'A', symbol: 'msft', chartType: 'line' });
      await c('POST', '/watchlists', { name: 'W', symbols: ['x', 'X', 'y'] });
      const ws = data<Workspace>(await c('GET', '/workspace'));
      await c('DELETE', `/watchlists/${ws.watchlists[0]?.id}`);
      const after = data<Workspace>(await c('GET', '/workspace'));
      const strip = (w: Workspace) => ({
        layouts: w.layouts.map(({ name, symbol, timeframe, chartType, indicators, revision }) => ({ name, symbol, timeframe, chartType, indicators, revision })),
        watchlists: w.watchlists.map(({ name, symbols, revision }) => ({ name, symbols, revision })),
        activeLayoutIsFirst: w.activeLayoutId === w.layouts[0]?.id,
        activeWatchlistIsFirst: w.activeWatchlistId === w.watchlists[0]?.id,
      });
      return strip(after);
    };
    expect(await steps(call)).toEqual(await steps(mockCall));
  });
});
