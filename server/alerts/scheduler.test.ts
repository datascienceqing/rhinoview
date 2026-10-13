import { describe, expect, it } from 'vitest';
import type { AlertEvent, AlertStreamMessage, Bar, CreateAlertBody, Snapshot, Timeframe } from '@shared/types';
import { QuotesCache } from '../cache/quotesCache';
import type { MarketEngine } from '../market/types';
import { MarketService } from '../provider/service';
import type { WorkspaceFs } from '../workspace/store';
import { DEFAULT_PARAMS } from '../../src/indicators/types';
import { AlertScheduler, BARS_RETRY_SECONDS } from './scheduler';
import type { AlertDataSource } from './scheduler';
import { serviceAlertSource } from './source';
import { openAlertsStore, STATE_FLUSH_SECONDS } from './store';
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

async function newStore(now: () => number, fs: WorkspaceFs = memFs()): Promise<AlertsStore> {
  let id = 0;
  return openAlertsStore('/mem/alerts.json', { fs, now, newId: () => `id${++id}`, warn: () => undefined });
}

const priceAlert = (symbol: string, level: number, over: Partial<CreateAlertBody> = {}): CreateAlertBody => ({
  symbol, condition: { type: 'price', direction: 'cross', level }, ...over,
});

const snap = (symbol: string, price: number): Snapshot => ({
  symbol, price, change: null, changePercent: null, previousClose: null, dayOpen: null, dayHigh: null, dayLow: null, dayVolume: null, updated: null, delayed: false,
});

/** A fake source that records each call and its time. */
function fakeSource(clock: () => number, priceOf: (s: string) => number = () => 100) {
  const calls: { kind: 'quote' | 'bars'; symbol: string; t: number; timeframe?: Timeframe; from?: number }[] = [];
  let bars: Bar[] = [];
  const source: AlertDataSource = {
    delayed: false,
    async quote(symbol) {
      calls.push({ kind: 'quote', symbol, t: clock() });
      return { snapshot: snap(symbol, priceOf(symbol)), cached: false };
    },
    async bars(symbol, timeframe, from) {
      calls.push({ kind: 'bars', symbol, t: clock(), timeframe, from });
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
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150, warn: () => undefined });
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

  it('when the budget is used up, expiries and cached quotes are still checked', async () => {
    let t = T0;
    const store = await newStore(() => t);
    const expiring = await store.create(priceAlert('MSFT', 100, { expiry: '1w' }));
    await store.create(priceAlert('NVDA', 100));
    await store.create(priceAlert('AAPL', 100));
    const { source, calls } = fakeSource(() => t);
    source.cachedQuote = (symbol) => (symbol === 'NVDA' ? snap('NVDA', 99) : undefined);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 1, warn: () => undefined });
    t = expiring.expiresAt - 1;
    await scheduler.tick();
    expect(calls.map((c) => c.symbol)).toEqual(['AAPL']);
    expect(store.list().find((x) => x.symbol === 'NVDA')?.state.lastSide).toBe('below');
    t = expiring.expiresAt;
    await scheduler.tick();
    expect(store.list().find((x) => x.id === expiring.id)?.status).toBe('expired');
  });

  it('warns the user when the budget runs out: once per shortage, at most 3 times', async () => {
    let t = T0;
    const store = await newStore(() => t);
    for (let i = 0; i < 20; i++) await store.create(priceAlert(`S${i}`, 200));
    const { source } = fakeSource(() => t);
    const notes: AlertStreamMessage[] = [];
    const warnings: string[] = [];
    const scheduler = new AlertScheduler({
      store, source, now: () => t, budgetPerMinute: 10, warn: (m) => warnings.push(m), notify: (m) => notes.push(m),
    });
    // One long shortage, a tick each second: one warning.
    for (let i = 0; i < 50; i++) {
      await scheduler.tick();
      t += 1;
    }
    expect(notes).toEqual([{ type: 'budget', budgetPerMinute: 10, waitingSymbols: 10 }]);
    // A shortage after more than a minute with none is a new one, up to the third.
    for (let i = 0; i < 5; i++) {
      t += 90;
      await scheduler.tick();
    }
    expect(notes).toHaveLength(3);
    expect(warnings.filter((w) => w.includes('calls of this minute are used'))).toHaveLength(3);
  });

  it('no budget warning when the budget is enough', async () => {
    let t = T0;
    const store = await newStore(() => t);
    for (let i = 0; i < 5; i++) await store.create(priceAlert(`S${i}`, 200));
    const { source } = fakeSource(() => t);
    const notes: AlertStreamMessage[] = [];
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150, notify: (m) => notes.push(m) });
    for (let i = 0; i < 120; i++) {
      await scheduler.tick();
      t += 1;
    }
    expect(notes).toEqual([]);
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

  it('intraday bars: with no new bar (market closed) the wait doubles up to BARS_RETRY_SECONDS', async () => {
    let t = T0;
    const store = await newStore(() => t);
    await store.create(sma('AAPL', '1m'));
    const { source, calls, setBars } = fakeSource(() => t);
    // The last bar closed an hour ago, and no new bar comes.
    setBars(Array.from({ length: 50 }, (_, i) => bar(T0 - 3600 - (50 - i) * 60, 90)));
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    for (let i = 0; i < 3 * 3600; i++) {
      await scheduler.tick();
      t += 1;
    }
    const times = calls.filter((c) => c.kind === 'bars').map((c) => c.t - T0);
    expect(times).toEqual([0, 60, 180, 420, 900, 1860, 3780, 7380]);
    expect(BARS_RETRY_SECONDS).toBe(3600);
  }, 30_000);

  it('intraday bars: a new bar sets the wait back to one bar span', async () => {
    let t = T0;
    const store = await newStore(() => t);
    await store.create(sma('AAPL', '1m'));
    const { source, calls, setBars } = fakeSource(() => t);
    const base = Array.from({ length: 50 }, (_, i) => bar(T0 - 3600 - (50 - i) * 60, 90));
    setBars(base);
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    for (let i = 0; i < 1000; i++) {
      await scheduler.tick();
      t += 1;
    }
    // Calls at 0, 60, 180, 420, 900; the next waits 960 s. A bar arrives before it.
    setBars([...base, bar(t - 120, 91)]);
    for (let i = 0; i < 1000; i++) {
      await scheduler.tick();
      t += 1;
    }
    const times = calls.filter((c) => c.kind === 'bars').map((c) => c.t - T0);
    expect(times.slice(0, 6)).toEqual([0, 60, 180, 420, 900, 1860]);
    expect(times[6]).toBe(1920);
  }, 30_000);

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

  it('confluence: the first bars call reaches back to the lock bar; later calls load only recent bars', async () => {
    const start = Math.floor(T0 / DAY) * DAY;
    let t = start + 3600;
    const store = await newStore(() => t);
    const lockTime = start - 1000 * DAY;
    await store.create({
      symbol: 'AAPL',
      condition: {
        type: 'confluence',
        timeframe: '1D',
        params: { ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: lockTime },
        lock: { bottom: 98, top: 100, count: 3, time: lockTime },
      },
      frequency: 'every',
    });
    const { source, calls, setBars } = fakeSource(() => t);
    const closes = Array.from({ length: 10 }, () => 90);
    setBars(closes.map((c, i) => bar(start - (10 - i) * DAY, c)));
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    await scheduler.tick();
    t = start + DAY + 5;
    setBars([...closes.map((c, i) => bar(start - (10 - i) * DAY, c)), bar(start, 90)]);
    await scheduler.tick();
    const froms = calls.filter((c) => c.kind === 'bars').map((c) => c.from as number);
    expect(froms).toHaveLength(2);
    // The volume average needs 10 bars before the lock bar.
    expect(froms[0]).toBeLessThan(lockTime - 10 * DAY);
    expect(froms[1]).toBeGreaterThan(lockTime);
    expect(store.list()[0]?.state.lastBarTime).toBe(start);
  });

  it('a 1D alert: the state of its first check is saved within STATE_FLUSH_SECONDS with no later check', async () => {
    const start = Math.floor(T0 / DAY) * DAY;
    let t = start + 3600;
    const fs = memFs();
    const store = await newStore(() => t, fs);
    await store.create(sma('AAPL'));
    const { source, calls, setBars } = fakeSource(() => t);
    setBars(Array.from({ length: 10 }, (_, i) => bar(start - (10 - i) * DAY, 90)));
    const scheduler = new AlertScheduler({ store, source, now: () => t, budgetPerMinute: 150 });
    // A restart reads the file: a new store on the same file system shows what is saved.
    const saved = async () => (await newStore(() => t, fs)).list()[0]?.state;
    await scheduler.tick();
    expect(store.list()[0]?.state).toMatchObject({ lastSide: 'below', lastBarTime: start - DAY });
    expect(await saved()).toMatchObject({ lastSide: null, lastBarTime: null });

    for (let i = 1; i < STATE_FLUSH_SECONDS; i++) {
      t += 1;
      await scheduler.tick();
    }
    expect(await saved()).toMatchObject({ lastSide: null, lastBarTime: null });
    t += 1;
    await scheduler.tick();
    expect(calls.filter((c) => c.kind === 'bars')).toHaveLength(1);
    expect(await saved()).toMatchObject({ lastSide: 'below', lastBarTime: start - DAY });
  });
});
