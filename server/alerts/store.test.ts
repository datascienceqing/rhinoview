import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertCheckState, AlertStreamMessage, CreateAlertBody } from '@shared/types';
import { MAX_ALERT_EVENTS } from '@shared/types';
import { computeExpiresAt } from '../../src/alerts/expiry';
import { ApiFailure } from '../provider/errors';
import { nodeWorkspaceFs } from '../workspace/store';
import type { WorkspaceFs } from '../workspace/store';
import type { AlertCheckResult } from './evaluate';
import { openAlertsStore, STATE_FLUSH_SECONDS } from './store';
import type { AlertsStore, AlertsStoreOptions } from './store';

const T0 = 1_790_000_000;
let dir: string;
let file: string;
let t: number;
let seq: number;
const opts = (over: AlertsStoreOptions = {}): AlertsStoreOptions => ({
  now: () => t,
  newId: () => `id${++seq}`,
  warn: () => undefined,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rhinoview-alerts-'));
  file = join(dir, 'alerts.json');
  t = T0;
  seq = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const priceBody = (level = 190, symbol = 'aapl'): CreateAlertBody => ({ symbol, condition: { type: 'price', direction: 'cross', level } });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof ApiFailure) return e.code;
    throw e;
  }
};

const state = (over: Partial<AlertCheckState> = {}): AlertCheckState => ({
  lastSide: 'below', lastCheckedAt: T0, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null, ...over,
});
const fire = (s: AlertCheckState, status: AlertCheckResult['status'] = 'triggered'): AlertCheckResult => ({
  state: { ...s, firedCount: s.firedCount + 1, lastFiredAt: t },
  status,
  fires: [{ crossed: 'up', value: 191, target: 190, time: t }],
});

describe('alerts store: file', () => {
  it('creates an empty file, and a reopen reads back what was written', async () => {
    const s1 = await openAlertsStore(file, opts());
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, alerts: [], events: [] });
    const a = await s1.create(priceBody());
    const s2 = await openAlertsStore(file, opts());
    expect(s2.list()).toEqual([a]);
  });

  it('renames a file that is not valid and starts empty', async () => {
    await writeFile(file, '{"version":1,"alerts":', 'utf8');
    const warnings: string[] = [];
    const s = await openAlertsStore(file, opts({ warn: (m) => warnings.push(m) }));
    expect(s.list()).toEqual([]);
    expect((await readdir(dir)).some((f) => f.startsWith('alerts.json.corrupt-'))).toBe(true);
    expect(warnings[0]).toMatch(/not valid/);
  });

  it('drops one invalid alert and keeps the others', async () => {
    const s1 = await openAlertsStore(file, opts());
    const good = await s1.create(priceBody());
    const json = JSON.parse(await readFile(file, 'utf8'));
    json.alerts.push({ ...good, id: 'bad', condition: { type: 'price', direction: 'cross', level: -1 } });
    json.alerts.push({ nonsense: true });
    await writeFile(file, JSON.stringify(json), 'utf8');
    const warnings: string[] = [];
    const s2 = await openAlertsStore(file, opts({ warn: (m) => warnings.push(m) }));
    expect(s2.list().map((a) => a.id)).toEqual([good.id]);
    expect(warnings[0]).toMatch(/dropped 2/);
  });

  it('keeps a saved MACD alert on the close, made before that target was refused', async () => {
    const s1 = await openAlertsStore(file, opts());
    const good = await s1.create(priceBody());
    const json = JSON.parse(await readFile(file, 'utf8'));
    const condition = { type: 'indicator', timeframe: '1D', indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } }, line: 'macd', direction: 'cross', target: { type: 'close' } };
    json.alerts.push({ ...good, id: 'old', condition });
    await writeFile(file, JSON.stringify(json), 'utf8');
    const s2 = await openAlertsStore(file, opts());
    expect(s2.list().map((a) => a.id)).toEqual([good.id, 'old']);
    // A new one is refused.
    expect(await code(s2.create({ symbol: 'AAPL', condition: condition as never }))).toBe('BAD_REQUEST');
  });

  it('a failed write changes neither the file nor the memory', async () => {
    let failing = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      async writeFileSynced(path, data) {
        if (failing) throw new Error('disk full');
        return nodeWorkspaceFs.writeFileSynced(path, data);
      },
    };
    const s = await openAlertsStore(file, opts({ fs }));
    const a = await s.create(priceBody());
    failing = true;
    await expect(s.update(a.id, { revision: 1, message: 'x' })).rejects.toThrow('disk full');
    expect(s.list()[0]).toEqual(a);
    expect(JSON.parse(await readFile(file, 'utf8')).alerts[0]).toEqual(a);
    failing = false;
    expect((await s.update(a.id, { revision: 1, message: 'x' })).revision).toBe(2);
  });
});

describe('alerts store: user edits', () => {
  let s: AlertsStore;
  beforeEach(async () => {
    s = await openAlertsStore(file, opts());
  });

  it('creates with the defaults and the expiry from now', async () => {
    const a = await s.create(priceBody());
    expect(a).toMatchObject({ id: 'id2', symbol: 'AAPL', frequency: 'once', expiry: '1M', message: '', status: 'active', revision: 1, createdAt: T0 });
    expect(a.expiresAt).toBe(computeExpiresAt(T0, '1M'));
  });

  it('rejects a bad symbol, condition or message', async () => {
    expect(await code(s.create(priceBody(190, 'A B')))).toBe('BAD_REQUEST');
    expect(await code(s.create(priceBody(0)))).toBe('BAD_REQUEST');
    expect(await code(s.create({ ...priceBody(), message: 'x'.repeat(201) }))).toBe('BAD_REQUEST');
    expect(s.list()).toEqual([]);
  });

  it('has no limit on the number of alerts or symbols', async () => {
    for (let i = 0; i < 1001; i++) await s.create(priceBody(10, `S${i}`));
    await s.create(priceBody());
    expect(s.list()).toHaveLength(1002);
    expect(new Set(s.list().map((a) => a.symbol)).size).toBe(1002);
    const reopened = await openAlertsStore(file, opts());
    expect(reopened.list()).toHaveLength(1002);
  }, 30_000);

  it('updates with the current revision; a stale one is CONFLICT; an unknown id is NOT_FOUND', async () => {
    const a = await s.create(priceBody());
    t += 100;
    const b = await s.update(a.id, { revision: 1, expiry: '1w', frequency: 'every' });
    expect(b).toMatchObject({ revision: 2, expiry: '1w', frequency: 'every', expiresAt: t + 7 * 86_400, updatedAt: t });
    expect(await code(s.update(a.id, { revision: 1, message: 'x' }))).toBe('CONFLICT');
    expect(await code(s.update('nope', { revision: 1 }))).toBe('NOT_FOUND');
  });

  it('a new condition resets the side; pausing keeps it; enabling resets it', async () => {
    const a = await s.create(priceBody());
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state({ lastDayHigh: 1, lastDayLow: 1 }), status: 'active', fires: [] }, delayed: false }]);
    const paused = await s.update(a.id, { revision: 1, status: 'paused' });
    expect(paused.state.lastSide).toBe('below');
    const active = await s.update(a.id, { revision: 2, status: 'active' });
    expect(active.state).toMatchObject({ lastSide: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null });
    await s.applyChecks([{ alertId: a.id, revision: 3, result: { state: state(), status: 'active', fires: [] }, delayed: false }]);
    const moved = await s.update(a.id, { revision: 3, condition: { type: 'price', direction: 'up', level: 200 } });
    expect(moved.state.lastSide).toBeNull();
  });

  it('enables a triggered alert again; an expired one gets a new expiry from now', async () => {
    const a = await s.create(priceBody());
    await s.applyChecks([{ alertId: a.id, revision: 1, result: fire(state()), delayed: false }]);
    expect(s.list()[0]?.status).toBe('triggered');
    const again = await s.update(a.id, { revision: 1, status: 'active' });
    expect(again).toMatchObject({ status: 'active', state: { firedCount: 1, lastSide: null } });

    await s.applyChecks([{ alertId: a.id, revision: 2, result: { state: state(), status: 'expired', fires: [] }, delayed: false }]);
    t = again.expiresAt + 10;
    const renewed = await s.update(a.id, { revision: 2, status: 'active' });
    expect(renewed.status).toBe('active');
    expect(renewed.expiresAt).toBeGreaterThan(t);
    await s.applyChecks([{ alertId: a.id, revision: 3, result: { state: state(), status: 'expired', fires: [] }, delayed: false }]);
    const byExpiry = await s.update(a.id, { revision: 3, expiry: '2w' });
    expect(byExpiry).toMatchObject({ status: 'active', expiresAt: t + 14 * 86_400 });
  });

  it('deletes', async () => {
    const a = await s.create(priceBody());
    expect(await s.remove(a.id)).toEqual({ id: a.id });
    expect(await code(s.remove(a.id))).toBe('NOT_FOUND');
  });
});

describe('alerts store: checks and events', () => {
  let s: AlertsStore;
  let messages: AlertStreamMessage[];
  beforeEach(async () => {
    s = await openAlertsStore(file, opts());
    messages = [];
    s.subscribe((m) => messages.push(m));
  });

  it('a fire makes an event, sets the status, keeps the revision, and streams it', async () => {
    const a = await s.create(priceBody());
    messages.length = 0;
    t += 30;
    const events = await s.applyChecks([{ alertId: a.id, revision: 1, result: fire(state()), delayed: true }]);
    expect(events).toEqual([
      { id: expect.any(String), alertId: a.id, symbol: 'AAPL', condition: a.condition, message: '', firedAt: t, crossed: 'up', value: 191, target: 190, delayed: true, checked: false },
    ]);
    const after = s.list()[0];
    expect(after).toMatchObject({ status: 'triggered', revision: 1, state: { firedCount: 1 } });
    expect(messages).toEqual([{ type: 'fired', event: events[0], alert: after }]);
    expect(s.events()).toEqual({ events, unchecked: 1 });
  });

  it('drops a check whose alert was edited or deleted while it ran', async () => {
    const a = await s.create(priceBody());
    const b = await s.create(priceBody(200));
    await s.update(a.id, { revision: 1, message: 'edited' });
    await s.remove(b.id);
    const events = await s.applyChecks([
      { alertId: a.id, revision: 1, result: fire(state()), delayed: false },
      { alertId: b.id, revision: 1, result: fire(state()), delayed: false },
    ]);
    expect(events).toEqual([]);
    expect(s.list()[0]?.status).toBe('active');
  });

  it('a check that only moves lastCheckedAt does not write the file', async () => {
    const a = await s.create(priceBody());
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state(), status: 'active', fires: [] }, delayed: false }]);
    const before = await readFile(file, 'utf8');
    t += 30;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state({ lastCheckedAt: t }), status: 'active', fires: [] }, delayed: false }]);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(s.list()[0]?.state.lastCheckedAt).toBe(t);
  });

  it('a side change without an event is saved within STATE_FLUSH_SECONDS', async () => {
    const a = await s.create(priceBody());
    const onDisk = async () => JSON.parse(await readFile(file, 'utf8')).alerts[0].state.lastSide;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state(), status: 'active', fires: [] }, delayed: false }]);
    expect(await onDisk()).toBeNull();
    t += STATE_FLUSH_SECONDS - 1;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state({ lastCheckedAt: t }), status: 'active', fires: [] }, delayed: false }]);
    expect(await onDisk()).toBeNull();
    t += 1;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state({ lastCheckedAt: t }), status: 'active', fires: [] }, delayed: false }]);
    expect(await onDisk()).toBe('below');
  });

  it('flush saves a state-only change once it is STATE_FLUSH_SECONDS old, with no later check', async () => {
    const a = await s.create(priceBody());
    const onDisk = async () => JSON.parse(await readFile(file, 'utf8')).alerts[0].state.lastSide;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state(), status: 'active', fires: [] }, delayed: false }]);
    t += STATE_FLUSH_SECONDS - 1;
    await s.flush();
    expect(await onDisk()).toBeNull();
    t += 1;
    await s.flush();
    expect(await onDisk()).toBe('below');
  });

  it('flush(true) saves a state-only change at once; flush with nothing waiting does not write', async () => {
    const a = await s.create(priceBody());
    const before = await readFile(file, 'utf8');
    t += STATE_FLUSH_SECONDS;
    await s.flush(true);
    expect(await readFile(file, 'utf8')).toBe(before);
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state(), status: 'active', fires: [] }, delayed: false }]);
    await s.flush(true);
    expect(JSON.parse(await readFile(file, 'utf8')).alerts[0].state.lastSide).toBe('below');
  });

  it('an expiry with no event sends an `alerts` message', async () => {
    const a = await s.create(priceBody());
    messages.length = 0;
    await s.applyChecks([{ alertId: a.id, revision: 1, result: { state: state(), status: 'expired', fires: [] }, delayed: false }]);
    expect(messages).toEqual([{ type: 'alerts' }]);
  });

  it(`keeps the newest ${MAX_ALERT_EVENTS} events`, async () => {
    const a = await s.create({ ...priceBody(), frequency: 'every' });
    let st = state();
    for (let i = 0; i < MAX_ALERT_EVENTS + 5; i++) {
      t += 1;
      const r = fire(st, 'active');
      await s.applyChecks([{ alertId: a.id, revision: 1, result: r, delayed: false }]);
      st = r.state;
    }
    const { events, unchecked } = s.events();
    expect(events).toHaveLength(MAX_ALERT_EVENTS);
    expect(unchecked).toBe(MAX_ALERT_EVENTS);
    expect(events[0]?.firedAt).toBe(t);
    const reopened = await openAlertsStore(file, opts());
    expect(reopened.events().events).toHaveLength(MAX_ALERT_EVENTS);
  }, 30_000);

  it('since filters, checked marks, delete removes, and each change streams the count', async () => {
    const a = await s.create({ ...priceBody(), frequency: 'every' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      t += 10;
      const [e] = await s.applyChecks([{ alertId: a.id, revision: 1, result: fire(state(), 'active'), delayed: false }]);
      ids.push((e as { id: string }).id);
    }
    expect(s.events(T0 + 10).events.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    messages.length = 0;
    expect(await s.setChecked({ ids: [ids[0] as string] })).toEqual({ unchecked: 2 });
    expect(await s.deleteEvent(ids[1] as string)).toEqual({ unchecked: 1 });
    expect(await s.setChecked({ all: true })).toEqual({ unchecked: 0 });
    expect(messages).toEqual([
      { type: 'checked', unchecked: 2, checkedIds: [ids[0]] },
      { type: 'checked', unchecked: 1, deletedId: ids[1] },
      { type: 'checked', unchecked: 0, checkedIds: 'all' },
    ]);
    expect(await code(s.deleteEvent('nope'))).toBe('NOT_FOUND');
  });

  it('an event keeps its condition after the alert is deleted', async () => {
    const a = await s.create(priceBody());
    await s.applyChecks([{ alertId: a.id, revision: 1, result: fire(state()), delayed: false }]);
    await s.remove(a.id);
    expect(s.events().events[0]).toMatchObject({ alertId: a.id, condition: { level: 190 } });
  });

  it('a listener that throws does not fail the saved change or stop the other listeners', async () => {
    const got: AlertStreamMessage[] = [];
    s.subscribe(() => {
      throw new Error('socket closed');
    });
    s.subscribe((m) => got.push(m));
    const a = await s.create(priceBody());
    expect(s.list().map((x) => x.id)).toEqual([a.id]);
    expect(got).toEqual([{ type: 'alerts' }]);
  });

  it('an indicator event keeps the bar time of the crossing; a price event has none', async () => {
    const ind = await s.create({
      symbol: 'AAPL',
      condition: { type: 'indicator', timeframe: '1D', indicator: { kind: 'rsi', params: { period: 14 } }, line: 'value', direction: 'cross', target: { type: 'value', value: 70 } },
    });
    const p = await s.create(priceBody());
    const indFire = { state: state(), status: 'triggered' as const, fires: [{ crossed: 'up' as const, value: 71, target: 70, time: T0 - 86_400 }] };
    await s.applyChecks([
      { alertId: ind.id, revision: 1, result: indFire, delayed: false },
      { alertId: p.id, revision: 1, result: fire(state()), delayed: false },
    ]);
    const events = s.events().events;
    expect(events.find((e) => e.alertId === ind.id)?.barTime).toBe(T0 - 86_400);
    expect(events.find((e) => e.alertId === p.id)).not.toHaveProperty('barTime');
  });

  it('unsubscribe stops the messages', async () => {
    const got: AlertStreamMessage[] = [];
    const off = s.subscribe((m) => got.push(m));
    await s.create(priceBody());
    off();
    await s.create(priceBody());
    expect(got).toHaveLength(1);
  });
});
