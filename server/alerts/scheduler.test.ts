import { describe, expect, it } from 'vitest';
import type { AlertEvent, AlertStreamMessage, Bar, CreateAlertBody, Snapshot, Timeframe } from '@shared/types';
import { QuotesCache } from '../cache/quotesCache';
import type { MarketEngine } from '../market/types';
import { MarketService } from '../provider/service';
import type { WorkspaceFs } from '../workspace/store';
import { AlertScheduler } from './scheduler';
import type { AlertDataSource } from './scheduler';
import { serviceAlertSource } from './source';
import { openAlertsStore } from './store';
import type { AlertsStore } from './store';

const T0 = 1_790_000_000;

/** An in-memory file system, so 1000 alerts need no disk. */
function memFs(): WorkspaceFs {
  const files = new Map<string, string>();
  return {
    mkdir: async () => undefined,
    readFile: async (p) => files.get(p) ?? null,
    writeFileSynced: async (p, d) => void files.set(p, d),
    rename: async (a, b) => {
      files.set(b, files.get(a) as string);
      files.delete(a);
    },
    rm: async (p) => void files.delete(p),
    exists: async (p) => files.has(p),
    syncDir: async () => undefined,
  };
}

async function newStore(now: () => number): Promise<AlertsStore> {
  let id = 0;
  return openAlertsStore('/mem/alerts.json', { fs: memFs(), now, newId: () => `id${++id}`, warn: () => undefined });
}

const priceAlert = (symbol: string, level: number, over: Partial<CreateAlertBody> = {}): CreateAlertBody => ({
  symbol, condition: { type: 'price', direction: 'cross', level }, ...over,
});

const snap = (symbol: string, price: number): Snapshot => ({
  symbol, price, change: null, changePercent: null, previousClose: null, dayOpen: null, dayHigh: null, dayLow: null, dayVolume: null, updated: null, delayed: false,
});

/** A fake source that records each call and its time. */
function fakeSource(clock: () => number, priceOf: (s: string) => number = () => 100) {
  const calls: { kind: 'quote' | 'bars'; symbol: string; t: number; timeframe?: Timeframe }[] = [];
  let bars: Bar[] = [];
  const source: AlertDataSource = {
    delayed: false,
    async quote(symbol) {
      calls.push({ kind: 'quote', symbol, t: clock() });
      return { snapshot: snap(symbol, priceOf(symbol)), cached: false };
    },
    async bars(symbol, timeframe) {
      calls.push({ kind: 'bars', symbol, t: clock(), timeframe });
      return bars;
    },
  };
  return { source, calls, setBars: (b: Bar[]) => (bars = b) };
}

describe('AlertScheduler: end to end with the market service', () => {
  it('a crossing between two checks gives exactly one event on the stream', async () => {
    let t = T0;
    let price = 99;
    const engine: MarketEngine = {
      supportedTimeframes: ['1D'],
      delayed: false,
      resolveSymbol: (s) => (s.toUpperCase() === 'AAPL' ? { symbol: 'AAPL', name: 'Apple', exchange: 'X', currency: 'USD', active: true, type: 'stock' } as never : undefined),
      searchSymbols: () => [],
      getBars: () => ({ bars: [], truncated: false }),
      getSnapshot: (symbol) => ({ ...snap(symbol, price), dayHigh: price, dayLow: price }),
    };
    const service = new MarketService({ engine, now: () => t });
    const store = await newStore(() => t);
    const quotes = new QuotesCache({ now: () => t * 1000 });
    const scheduler = new AlertScheduler({ store, source: serviceAlertSource(service, quotes), now: () => t, budgetPerMinute: 150 });
    const fired: AlertEvent[] = [];
    store.subscribe((m: AlertStreamMessage) => {
      if (m.type === 'fired') fired.push(m.event);
    });

    await store.create(priceAlert('AAPL', 100));
    await scheduler.tick(); // first check: side only
    expect(fired).toEqual([]);
    expect(store.list()[0]?.state.lastSide).toBe('below');

    t += 10;
    price = 101;
    await scheduler.tick(); // not due yet (30 s rule)
    expect(fired).toEqual([]);

    t += 20;
    await scheduler.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ symbol: 'AAPL', crossed: 'up', value: 101, target: 100, firedAt: t });
    expect(store.list()[0]?.status).toBe('triggered');

    for (let i = 0; i < 5; i++) {
      t += 30;
      price = i % 2 === 0 ? 99 : 101;
      await scheduler.tick();
    }
    expect(fired).toHaveLength(1);
  });

  it('a quote in the shared cache costs no call', async () => {
    let t = T0;
    let upstream = 0;
    const engine = {
      supportedTimeframes: ['1D'],
      delayed: false,
      resolveSymbol: (s: string) => ({ symbol: s.toUpperCase() }) as never,
      searchSymbols: () => [],
      getBars: () => ({ bars: [], truncated: false }),
      getSnapshot: (symbol: string) => {
        upstream++;
        return snap(symbol, 100);
      },
    } as unknown as MarketEngine;
    const service = new MarketService({ engine, now: () => t });
    const quotes = new QuotesCache({ now: () => t * 1000 });
    quotes.set('MSFT', snap('MSFT', 100)); // the watchlist loaded it just now
    const store = await newStore(() => t);
    await store.create(priceAlert('MSFT', 120));
    const scheduler = new AlertScheduler({ store, source: serviceAlertSource(service, quotes), now: () => t, budgetPerMinute: 150 });
    await scheduler.tick();
    expect(upstream).toBe(0);
    expect(scheduler.callsInLastMinute()).toBe(0);
    t += 30;
    await scheduler.tick();
    expect(upstream).toBe(1);
    expect(scheduler.callsInLastMinute()).toBe(1);
  });
});

describe('AlertScheduler: budget', () => {
  it('1000 symbols: at most 150 calls in any minute, no symbol more often than each 30 s, all checked', async () => {
    let t = T0;
    const store = await newStore(() => t);
    for (let i = 0; i < 1000; i++) await store.create(priceAlert(`S${i}`, 200));
    const { source, calls } = fakeSource(() => t);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    expect(scheduler.checkIntervalSeconds()).toBe(400);

    for (let s = 0; s < 15 * 60; s++) {
      await scheduler.tick();
      t += 1;
    }
    // Any 60 s window.
    const times = calls.map((c) => c.t);
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((x) => x > (times[i] as number) - 60 && x <= (times[i] as number)).length;
      expect(inWindow).toBeLessThanOrEqual(150);
    }
    // Each symbol: gaps of at least 30 s, and checked at least twice in 15 min.
    const bySymbol = new Map<string, number[]>();
    for (const c of calls) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c.t]);
    expect(bySymbol.size).toBe(1000);
    for (const ts of bySymbol.values()) {
      expect(ts.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < ts.length; i++) expect((ts[i] as number) - (ts[i - 1] as number)).toBeGreaterThanOrEqual(30);
    }
  }, 60_000);

  it('no budget (synthetic): every symbol each 30 s', async () => {
    let t = T0;
    const store = await newStore(() => t);
    for (let i = 0; i < 20; i++) await store.create(priceAlert(`S${i}`, 200));
    const { source, calls } = fakeSource(() => t);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: null });
    expect(scheduler.checkIntervalSeconds()).toBe(30);
    for (let s = 0; s < 120; s++) {
      await scheduler.tick();
      t += 1;
    }
    expect(calls).toHaveLength(20 * 4);
  });

  it('a symbol with many alerts costs one quote', async () => {
    const t = T0;
    const store = await newStore(() => t);
    for (let i = 0; i < 5; i++) await store.create(priceAlert('AAPL', 100 + i));
    const { source, calls } = fakeSource(() => t);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    await scheduler.tick();
    expect(calls).toHaveLength(1);
    expect(store.list().every((a) => a.state.lastSide !== null)).toBe(true);
  });

  it('paused, triggered and expired alerts are not checked; expiry needs no call', async () => {
    let t = T0;
    const store = await newStore(() => t);
    const a = await store.create(priceAlert('AAPL', 100, { expiry: '1w' }));
    const b = await store.create(priceAlert('MSFT', 100));
    await store.update(b.id, { revision: 1, status: 'paused' });
    const { source, calls } = fakeSource(() => t);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    t = a.expiresAt;
    await scheduler.tick();
    expect(calls).toEqual([]);
    expect(store.list().find((x) => x.id === a.id)?.status).toBe('expired');
  });

  it('a tick does not run twice at once', async () => {
    let t = T0;
    const store = await newStore(() => t);
    await store.create(priceAlert('AAPL', 100));
    let release: () => void = () => undefined;
    let count = 0;
    const source: AlertDataSource = {
      delayed: false,
      quote: (symbol) => {
        count++;
        return new Promise((r) => {
          release = () => r({ snapshot: snap(symbol, 99), cached: false });
        });
      },
      bars: async () => [],
    };
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: null });
    const first = scheduler.tick();
    t += 60;
    await scheduler.tick();
    release();
    await first;
    expect(count).toBe(1);
  });
});

describe('AlertScheduler: indicator alerts', () => {
  const DAY = 86_400;
  const bar = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close, volume: 1, vwap: null, transactions: null });
  const sma = (symbol: string, timeframe: Timeframe = '1D'): CreateAlertBody => ({
    symbol,
    condition: { type: 'indicator', timeframe, indicator: { kind: 'sma', params: { period: 3, source: 'close' } }, line: 'value', direction: 'cross', target: { type: 'value', value: 100 } },
    frequency: 'every',
  });

  it('one bars call serves all alerts of a symbol and timeframe, and the next call waits for a bar close', async () => {
    const start = Math.floor(T0 / DAY) * DAY;
    let t = start + 3600;
    const store = await newStore(() => t);
    await store.create(sma('AAPL'));
    await store.create({ ...sma('AAPL'), condition: { ...(sma('AAPL').condition as object), target: { type: 'value', value: 50 } } as never });
    const { source, calls, setBars } = fakeSource(() => t);
    const closes = Array.from({ length: 10 }, () => 90);
    setBars(closes.map((c, i) => bar(start - (10 - i) * DAY, c)));
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    await scheduler.tick();
    expect(calls.filter((c) => c.kind === 'bars')).toHaveLength(1);
    expect(store.list().every((a) => a.state.lastBarTime === start - DAY)).toBe(true);

    // Each minute for most of the day: no new bar can have closed, so no call.
    for (let i = 0; i < 20 * 60; i++) {
      t += 60;
      await scheduler.tick();
    }
    expect(calls.filter((c) => c.kind === 'bars')).toHaveLength(1);

    // Today's bar closes at start + DAY. A close of 300 lifts SMA(3) over 100.
    t = start + DAY + 5;
    setBars([...closes.map((c, i) => bar(start - (10 - i) * DAY, c)), bar(start, 300)]);
    const fired: AlertStreamMessage[] = [];
    store.subscribe((m) => m.type === 'fired' && fired.push(m));
    await scheduler.tick();
    expect(calls.filter((c) => c.kind === 'bars')).toHaveLength(2);
    expect(fired).toHaveLength(1);
  });
});
