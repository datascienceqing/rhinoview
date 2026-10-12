/**
 * Alerts HTTP routes against a real store in a temp directory, the SSE stream on a real
 * socket, and a side-by-side run against the MSW mock (mocks/alerts.ts).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Alert, AlertEventsResponse, ApiResult } from '@shared/types';
import { createAlertsHandlers, resetMockAlerts } from '../../mocks/alerts';
import { openAlertsStore } from '../alerts/store';
import type { AlertsStore } from '../alerts/store';
import { buildServer } from '../index';
import type { MarketEngine } from '../market/types';

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

let dir: string;
let app: FastifyInstance;
let store: AlertsStore;

const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
  const res = await app.inject({ method: method as 'GET', url: `/api${path}`, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json() as ApiResult<unknown> };
};
const data = <T>(r: Reply): T => {
  if (!r.body.ok) throw new Error(`expected ok, got ${JSON.stringify(r.body.error)}`);
  return r.body.data as T;
};
const errCode = (r: Reply) => (r.body.ok ? 'ok' : r.body.error.code);
const priceBody = (level = 190) => ({ symbol: 'aapl', condition: { type: 'price', direction: 'cross', level } });
const fireState = { lastSide: 'above' as const, lastCheckedAt: 1, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 1, lastFiredAt: 1 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rhinoview-alert-routes-'));
  store = await openAlertsStore(join(dir, 'alerts.json'), { warn: () => undefined });
  app = buildServer({ engine, alerts: store });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('alerts routes', () => {
  it('create, list, update, delete', async () => {
    const created = await call('POST', '/alerts', priceBody());
    expect(created.status).toBe(201);
    const a = data<Alert>(created);
    expect(a.symbol).toBe('AAPL');
    expect(data<{ alerts: Alert[] }>(await call('GET', '/alerts')).alerts).toHaveLength(1);
    expect(data<Alert>(await call('PUT', `/alerts/${a.id}`, { revision: 1, message: 'm' })).revision).toBe(2);
    expect(errCode(await call('PUT', `/alerts/${a.id}`, { revision: 1, message: 'm' }))).toBe('CONFLICT');
    expect(data(await call('DELETE', `/alerts/${a.id}`))).toEqual({ id: a.id });
    const gone = await call('DELETE', `/alerts/${a.id}`);
    expect([gone.status, errCode(gone)]).toEqual([404, 'NOT_FOUND']);
  });

  it('rejects unknown fields and bad values with 400, before it looks up the id', async () => {
    expect(errCode(await call('POST', '/alerts', { ...priceBody(), extra: 1 }))).toBe('BAD_REQUEST');
    expect(errCode(await call('POST', '/alerts', priceBody(-1)))).toBe('BAD_REQUEST');
    expect(errCode(await call('PUT', '/alerts/nope', { revision: 1, bogus: 1 }))).toBe('BAD_REQUEST');
    expect(errCode(await call('PUT', '/alerts/nope', { revision: 1 }))).toBe('NOT_FOUND');
    expect(errCode(await call('GET', '/alerts/events?since=x'))).toBe('BAD_REQUEST');
    expect(errCode(await call('GET', '/alerts/events?other=1'))).toBe('BAD_REQUEST');
  });

  it('events: list with since, mark checked, delete', async () => {
    const a = data<Alert>(await call('POST', '/alerts', { ...priceBody(), frequency: 'every' }));
    const fire = { state: fireState, status: 'active' as const, fires: [{ crossed: 'up' as const, value: 191, target: 190, time: 1 }] };
    const [e1] = await store.applyChecks([{ alertId: a.id, revision: 1, result: fire, delayed: false }]);
    const list = data<AlertEventsResponse>(await call('GET', '/alerts/events'));
    expect(list).toEqual({ events: [e1], unchecked: 1 });
    expect(data<AlertEventsResponse>(await call('GET', `/alerts/events?since=${e1?.firedAt}`)).events).toEqual([]);
    expect(data(await call('PUT', '/alerts/events/checked', { all: true }))).toEqual({ unchecked: 0 });
    expect(data(await call('DELETE', `/alerts/events/${e1?.id}`))).toEqual({ unchecked: 0 });
    expect(errCode(await call('PUT', '/alerts/events/checked', { all: false }))).toBe('BAD_REQUEST');
  });

  it('answers INTERNAL when there is no store', async () => {
    const bare = buildServer({ engine });
    const r = await bare.inject({ method: 'GET', url: '/api/alerts' });
    expect(r.statusCode).toBe(500);
    await bare.close();
  });
});

describe('alerts stream', () => {
  /** Opens the stream on a real socket and collects the text. */
  async function openStream(): Promise<{ text: () => string; res: IncomingMessage; close: () => void }> {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    return new Promise((resolve, reject) => {
      const req = get(`${address}/api/alerts/stream`, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        // Resolve after the first chunk, so the subscription exists.
        res.once('data', () => resolve({ text: () => text, res, close: () => req.destroy() }));
      });
      req.on('error', reject);
    });
  }

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('sends alerts, fired and checked messages as named SSE events', async () => {
    const s = await openStream();
    expect(s.res.headers['content-type']).toBe('text/event-stream');
    const a = data<Alert>(await call('POST', '/alerts', priceBody()));
    await until(() => s.text().includes('event: alerts'));
    const fire = { state: fireState, status: 'triggered' as const, fires: [{ crossed: 'up' as const, value: 191, target: 190, time: 1 }] };
    const [event] = await store.applyChecks([{ alertId: a.id, revision: 1, result: fire, delayed: false }]);
    await until(() => s.text().includes('event: fired'));
    const frame = s.text().split('\n\n').find((f) => f.startsWith('event: fired')) as string;
    const message = JSON.parse(frame.split('\ndata: ')[1] as string);
    expect(message).toMatchObject({ type: 'fired', event, alert: { id: a.id, status: 'triggered' } });
    await call('PUT', '/alerts/events/checked', { all: true });
    await until(() => s.text().includes('event: checked\ndata: {"type":"checked","unchecked":0,"checkedIds":"all"}'));
    s.close();
  });

  it('two streams get the same single event (one checker, many tabs)', async () => {
    const s1 = await openStream();
    const address = app.server.address() as { port: number };
    const s2 = await new Promise<{ text: () => string; close: () => void }>((resolve) => {
      const req = get(`http://127.0.0.1:${address.port}/api/alerts/stream`, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.once('data', () => resolve({ text: () => text, close: () => req.destroy() }));
      });
    });
    const a = data<Alert>(await call('POST', '/alerts', priceBody()));
    const fire = { state: fireState, status: 'triggered' as const, fires: [{ crossed: 'up' as const, value: 191, target: 190, time: 1 }] };
    await store.applyChecks([{ alertId: a.id, revision: 1, result: fire, delayed: false }]);
    await until(() => s1.text().includes('event: fired') && s2.text().includes('event: fired'));
    const count = (t: string) => t.split('event: fired').length - 1;
    expect([count(s1.text()), count(s2.text())]).toEqual([1, 1]);
    s1.close();
    s2.close();
  });

  it('sends a budget message that the checker publishes', async () => {
    const s = await openStream();
    store.publish({ type: 'budget', budgetPerMinute: 150, waitingSymbols: 7 });
    await until(() => s.text().includes('event: budget\ndata: {"type":"budget","budgetPerMinute":150,"waitingSymbols":7}'));
    s.close();
  });

  it('ends the open streams when the server closes, so close does not wait for the tabs', async () => {
    const s = await openStream();
    const ended = new Promise<void>((resolve) => s.res.once('end', () => resolve()));
    await app.close();
    await ended;
  });
});

describe('alerts routes and the MSW mock answer alike', () => {
  const msw = setupServer(...createAlertsHandlers());
  beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => msw.close());
  beforeEach(() => resetMockAlerts());

  const viaMock = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`http://mock.test/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as ApiResult<unknown> };
  };

  it('gives the same status and code for the same requests', async () => {
    const steps: [string, string, unknown?][] = [
      ['POST', '/alerts', priceBody()],
      ['POST', '/alerts', { ...priceBody(), extra: 1 }],
      ['POST', '/alerts', priceBody(Number.NaN)],
      ['POST', '/alerts', { symbol: 'AAPL', condition: { type: 'indicator', timeframe: '1D', indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } }, line: 'macd', direction: 'up', target: { type: 'line', line: 'macd' } } }],
      ['PUT', '/alerts/nope', { revision: 1 }],
      ['PUT', '/alerts/nope', { revision: 0 }],
      ['DELETE', '/alerts/nope'],
      ['GET', '/alerts/events?since=-1'],
      ['PUT', '/alerts/events/checked', { ids: [] }],
      ['PUT', '/alerts/events/checked', { all: true }],
      ['DELETE', '/alerts/events/nope'],
    ];
    for (const [method, path, body] of steps) {
      const real = await call(method, path, body);
      const mock = await viaMock(method, path, body);
      expect([method, path, mock.status, errCode(mock)]).toEqual([method, path, real.status, errCode(real)]);
    }
  });
});
