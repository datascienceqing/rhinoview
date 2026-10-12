import type { Alert, AlertEventsResponse, AlertsResponse, ApiResult } from '@shared/types';
import { mockAlerts, mockFireAlert, resetMockAlerts } from '../../mocks/alerts';

const URL_BASE = 'http://localhost/api';

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; result: ApiResult<T> }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, result: (await res.json()) as ApiResult<T> };
}

const data = <T>(r: { result: ApiResult<T> }): T => {
  if (!r.result.ok) throw new Error(`${r.result.error.code}: ${r.result.error.message}`);
  return r.result.data;
};

const priceBody = (level = 190, symbol = 'aapl') => ({ symbol, condition: { type: 'price', direction: 'cross', level } });

beforeEach(() => resetMockAlerts());

describe('alerts mock: create', () => {
  it('creates an alert with the defaults and a canonical symbol', async () => {
    const r = await call<Alert>('POST', '/alerts', priceBody());
    expect(r.status).toBe(201);
    const a = data(r);
    expect(a).toMatchObject({ symbol: 'AAPL', frequency: 'once', expiry: '1M', message: '', status: 'active', revision: 1 });
    expect(a.state).toEqual({ lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null });
    expect(a.expiresAt).toBeGreaterThan(a.createdAt + 27 * 86400);
    expect(data(await call<AlertsResponse>('GET', '/alerts')).alerts).toHaveLength(1);
  });

  it('rejects unknown fields, a bad symbol, a bad condition, and a long message', async () => {
    const bad = [
      { ...priceBody(), extra: 1 },
      priceBody(190, 'A B'),
      priceBody(-5),
      { ...priceBody(), message: 'x'.repeat(201) },
      { ...priceBody(), expiry: '4w' },
      { symbol: 'AAPL', condition: { type: 'indicator', timeframe: '1D', indicator: { kind: 'vpvr', params: {} }, line: 'value', direction: 'up', target: { type: 'close' } } },
    ];
    for (const b of bad) {
      const r = await call('POST', '/alerts', b);
      expect(r.status).toBe(400);
      expect(r.result.ok).toBe(false);
    }
    expect(mockAlerts().alerts).toHaveLength(0);
  });

  it('has no limit on the number of alerts or symbols', async () => {
    const many: Alert[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `a${i}`, symbol: `S${i}`, condition: { type: 'price', direction: 'cross', level: 1 }, frequency: 'once',
      expiry: '1M', expiresAt: 2_000_000_000, message: '', status: 'active', revision: 1, createdAt: 1, updatedAt: 1,
      state: { lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null },
    }));
    resetMockAlerts({ alerts: many });
    expect((await call('POST', '/alerts', priceBody())).status).toBe(201);
    expect(mockAlerts().alerts).toHaveLength(1002);
  });
});

describe('alerts mock: update and delete', () => {
  it('updates with the current revision and rejects a stale one', async () => {
    const a = data(await call<Alert>('POST', '/alerts', priceBody()));
    const b = data(await call<Alert>('PUT', `/alerts/${a.id}`, { revision: 1, frequency: 'every', expiry: '1w', message: 'hi' }));
    expect(b).toMatchObject({ frequency: 'every', expiry: '1w', message: 'hi', revision: 2 });
    expect(b.expiresAt).toBeLessThan(a.expiresAt);
    const stale = await call('PUT', `/alerts/${a.id}`, { revision: 1, message: 'x' });
    expect(stale.status).toBe(409);
  });

  it('validates the body before it looks up the id', async () => {
    expect((await call('PUT', '/alerts/nope', { revision: 1, bogus: true })).status).toBe(400);
    expect((await call('PUT', '/alerts/nope', { revision: 1 })).status).toBe(404);
  });

  it('enables a triggered alert again and resets its side', async () => {
    const a = data(await call<Alert>('POST', '/alerts', priceBody()));
    mockFireAlert(a.id, 191, 190);
    const fired = mockAlerts().alerts[0] as Alert;
    expect(fired.status).toBe('triggered');
    const b = data(await call<Alert>('PUT', `/alerts/${a.id}`, { revision: fired.revision, status: 'active' }));
    expect(b.status).toBe('active');
    expect(b.state.lastSide).toBeNull();
    expect(b.state.firedCount).toBe(1);
  });

  it('deletes an alert and answers 404 for an unknown id', async () => {
    const a = data(await call<Alert>('POST', '/alerts', priceBody()));
    expect(data(await call<{ id: string }>('DELETE', `/alerts/${a.id}`))).toEqual({ id: a.id });
    expect((await call('DELETE', `/alerts/${a.id}`)).status).toBe(404);
  });
});

describe('alerts mock: events', () => {
  it('lists events newest first, filters by since, and counts unchecked', async () => {
    const a = data(await call<Alert>('POST', '/alerts', { ...priceBody(), frequency: 'every' }));
    const e1 = mockFireAlert(a.id, 191, 190, 'up');
    const e2 = mockFireAlert(a.id, 189, 190, 'down');
    const all = data(await call<AlertEventsResponse>('GET', '/alerts/events'));
    expect(all.events.map((e) => e.id)).toEqual([e2.id, e1.id]);
    expect(all.unchecked).toBe(2);
    const later = data(await call<AlertEventsResponse>('GET', `/alerts/events?since=${e1.firedAt}`));
    expect(later.events.map((e) => e.id)).toEqual([e2.id]);
    expect((await call('GET', '/alerts/events?since=abc')).status).toBe(400);
  });

  it('marks events as checked by id or all, and deletes an event', async () => {
    const a = data(await call<Alert>('POST', '/alerts', { ...priceBody(), frequency: 'every' }));
    const e1 = mockFireAlert(a.id, 191, 190);
    mockFireAlert(a.id, 192, 190);
    const e3 = mockFireAlert(a.id, 193, 190);
    expect(data(await call<{ unchecked: number }>('PUT', '/alerts/events/checked', { ids: [e1.id] }))).toEqual({ unchecked: 2 });
    expect(data(await call<{ unchecked: number }>('DELETE', `/alerts/events/${e3.id}`))).toEqual({ unchecked: 1 });
    expect(data(await call<{ unchecked: number }>('PUT', '/alerts/events/checked', { all: true }))).toEqual({ unchecked: 0 });
    expect((await call('PUT', '/alerts/events/checked', { all: false })).status).toBe(400);
    expect((await call('PUT', '/alerts/events/checked', { ids: [] })).status).toBe(400);
    expect(mockAlerts().events).toHaveLength(2);
  });

  it('keeps the event after its alert is deleted', async () => {
    const a = data(await call<Alert>('POST', '/alerts', priceBody()));
    mockFireAlert(a.id, 191, 190);
    await call('DELETE', `/alerts/${a.id}`);
    const r = data(await call<AlertEventsResponse>('GET', '/alerts/events'));
    expect(r.events[0]).toMatchObject({ alertId: a.id, symbol: 'AAPL', condition: { type: 'price', level: 190 } });
  });
});
