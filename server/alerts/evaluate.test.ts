import { describe, expect, it } from 'vitest';
import type { Alert, AlertCheckState, AlertCondition, AlertDirection, Bar, ConfluenceParams } from '@shared/types';
import { computeConfluence } from '../../src/indicators/confluence';
import { randomBars } from '../../src/indicators/fixtures';
import { DEFAULT_PARAMS } from '../../src/indicators/types';
import { closedBars, evaluateAlert, evaluateConfluenceAlert, evaluateIndicatorAlert, evaluatePriceAlert, MAX_FIRES_PER_CHECK } from './evaluate';
import type { PriceObservation } from './evaluate';

const T0 = 1_790_000_000;
const EMPTY: AlertCheckState = {
  lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null,
};

function alertOf(condition: AlertCondition, over: Partial<Alert> = {}): Alert {
  return {
    id: 'a1', symbol: 'AAPL', condition, frequency: 'once', expiry: '1M', expiresAt: T0 + 3650 * 86_400, message: '',
    status: 'active', revision: 1, createdAt: T0, updatedAt: T0, state: EMPTY, ...over,
  };
}

const price = (level: number, direction: AlertDirection = 'cross') => alertOf({ type: 'price', direction, level });
const obs = (p: number | null, dayHigh: number | null = null, dayLow: number | null = null): PriceObservation => ({ price: p, dayHigh, dayLow });

/** Runs observations one by one, as the scheduler does, and collects the fired directions. */
function run(alert: Alert, seq: PriceObservation[]): { alert: Alert; fired: string[] } {
  let a = alert;
  const fired: string[] = [];
  seq.forEach((o, i) => {
    const r = evaluatePriceAlert(a, o, T0 + (i + 1) * 30);
    fired.push(...r.fires.map((f) => f.crossed));
    a = { ...a, state: r.state, status: r.status };
  });
  return { alert: a, fired };
}

describe('evaluatePriceAlert: crossings', () => {
  it('the first check records the side and does not fire, also at the level', () => {
    const r = evaluatePriceAlert(price(100), obs(100), T0 + 1);
    expect(r.fires).toEqual([]);
    expect(r.state.lastSide).toBe('above');
    expect(r.state.lastCheckedAt).toBe(T0 + 1);
    expect(r.status).toBe('active');
  });

  it('crossing fires in either direction', () => {
    expect(run(price(100), [obs(99), obs(101)]).fired).toEqual(['up']);
    expect(run(price(100), [obs(101), obs(99)]).fired).toEqual(['down']);
  });

  it('reaching the level from below is a crossing up', () => {
    expect(run(price(100), [obs(99), obs(100)]).fired).toEqual(['up']);
  });

  it('crossing up ignores a crossing down, and the mirror', () => {
    expect(run(price(100, 'up'), [obs(101), obs(99)]).fired).toEqual([]);
    expect(run(price(100, 'down'), [obs(99), obs(101)]).fired).toEqual([]);
    expect(run(price(100, 'up'), [obs(99), obs(101)]).fired).toEqual(['up']);
    expect(run(price(100, 'down'), [obs(101), obs(99)]).fired).toEqual(['down']);
  });

  it('no fire while the price stays on one side', () => {
    expect(run(price(100), [obs(90), obs(95), obs(99.99)]).fired).toEqual([]);
  });

  it('gives the value, the level and the check time', () => {
    const a = { ...price(100), state: { ...EMPTY, lastSide: 'below' as const } };
    expect(evaluatePriceAlert(a, obs(101.5), T0 + 5).fires).toEqual([{ crossed: 'up', value: 101.5, target: 100, time: T0 + 5 }]);
  });

  it('a missing price changes nothing but the check time', () => {
    const a = { ...price(100), state: { ...EMPTY, lastSide: 'below' as const } };
    const r = evaluatePriceAlert(a, obs(null), T0 + 5);
    expect(r.fires).toEqual([]);
    expect(r.state).toEqual({ ...a.state, lastCheckedAt: T0 + 5 });
  });
});

describe('evaluatePriceAlert: once, every, status, expiry', () => {
  it('once fires one time, then the alert is triggered and is not checked', () => {
    const { alert, fired } = run(price(100), [obs(99), obs(101), obs(99), obs(101)]);
    expect(fired).toEqual(['up']);
    expect(alert.status).toBe('triggered');
    expect(alert.state.firedCount).toBe(1);
    expect(alert.state.lastFiredAt).toBe(T0 + 60);
  });

  it('every fires on each new crossing, and must cross back first', () => {
    const every = { ...price(100, 'up'), frequency: 'every' as const };
    const r = run(every, [obs(99), obs(101), obs(102), obs(99), obs(101)]);
    expect(r.fired).toEqual(['up', 'up']);
    expect(r.alert.status).toBe('active');
    expect(r.alert.state.firedCount).toBe(2);
  });

  it('a paused, triggered or expired alert is not checked and keeps its state', () => {
    for (const status of ['paused', 'triggered', 'expired'] as const) {
      const a = { ...price(100), status, state: { ...EMPTY, lastSide: 'below' as const } };
      const r = evaluatePriceAlert(a, obs(101), T0 + 5);
      expect(r).toEqual({ state: a.state, status, fires: [] });
    }
  });

  it('expires at expiresAt and does not fire then', () => {
    const a = { ...price(100), expiresAt: T0 + 10, state: { ...EMPTY, lastSide: 'below' as const } };
    expect(evaluatePriceAlert(a, obs(101), T0 + 9).fires).toHaveLength(1);
    const r = evaluatePriceAlert(a, obs(101), T0 + 10);
    expect(r.status).toBe('expired');
    expect(r.fires).toEqual([]);
  });
});

describe('evaluatePriceAlert: day high and day low', () => {
  it('a day high that rose through the level fires, even when the price fell back', () => {
    const r = run(price(100), [obs(98, 99, 97), obs(98.5, 100.4, 97)]);
    expect(r.fired).toEqual(['up']);
  });

  it('the spike also counts as the crossing back for a crossing down alert', () => {
    expect(run(price(100, 'down'), [obs(98, 99, 97), obs(98.5, 100.4, 97)]).fired).toEqual(['down']);
  });

  it('every + crossing reports the spike and the move back from one check', () => {
    const every = { ...price(100), frequency: 'every' as const };
    expect(run(every, [obs(98, 99, 97), obs(98.5, 100.4, 97)]).fired).toEqual(['up', 'down']);
    expect(run(every, [obs(102, 103, 101), obs(101.5, 103, 99.6)]).fired).toEqual(['down', 'up']);
  });

  it('once + crossing fires only the first crossing of the spike', () => {
    const r = run(price(100), [obs(98, 99, 97), obs(98.5, 100.4, 97)]);
    expect(r.fired).toEqual(['up']);
    expect(r.alert.status).toBe('triggered');
  });

  it('a day low that fell through the level fires', () => {
    expect(run(price(100), [obs(102, 103, 101), obs(101.5, 103, 99.6)]).fired).toEqual(['down']);
    expect(run(price(100, 'up'), [obs(102, 103, 101), obs(101.5, 103, 99.6)]).fired).toEqual(['up']);
  });

  it('a day high above the level from before the last check does not fire', () => {
    // The high of 105 was already there at the first check: no new move through the level.
    expect(run(price(100), [obs(98, 105, 97), obs(98.5, 105, 97)]).fired).toEqual([]);
  });

  it('a new session counts its whole range', () => {
    // The high and the low both moved inwards: a new day. The new high 100.2 is >= the level.
    expect(run(price(100), [obs(98, 103, 97), obs(99, 100.2, 98)]).fired).toEqual(['up']);
  });

  it('without the day values of the last check, only the price counts', () => {
    expect(run(price(100), [obs(98), obs(98.5, 100.4, 97)]).fired).toEqual([]);
  });

  it('stores the day values', () => {
    const r = evaluatePriceAlert(price(100), obs(98, 99, 97), T0);
    expect(r.state).toMatchObject({ lastDayHigh: 99, lastDayLow: 97 });
  });
});

// ── Indicator alerts ──

const DAY = 86_400;
const bar = (i: number, close: number): Bar => ({ time: T0 + i * DAY, open: close, high: close, low: close, close, volume: 1000, vwap: null, transactions: null });
const barsOf = (closes: number[]) => closes.map((c, i) => bar(i, c));
/** `now` such that every bar in `bars` is closed. */
const after = (bars: Bar[]) => (bars[bars.length - 1] as Bar).time + DAY;

const smaCross = (direction: AlertDirection = 'cross', over: Partial<Alert> = {}) =>
  alertOf(
    { type: 'indicator', timeframe: '1D', indicator: { kind: 'sma', params: { period: 3, source: 'close' } }, line: 'value', direction, target: { type: 'value', value: 100 } },
    over,
  );

/** Checks the bars step by step, one more bar each time, as the scheduler does at bar close. */
function runBars(alert: Alert, closes: number[], firstCheckAt: number) {
  let a = alert;
  const fires: number[] = [];
  const all = barsOf(closes);
  for (let n = firstCheckAt; n <= all.length; n++) {
    const bars = all.slice(0, n);
    const r = evaluateIndicatorAlert(a, bars, after(bars));
    fires.push(...r.fires.map((f) => f.time));
    a = { ...a, state: r.state, status: r.status };
  }
  return { alert: a, fires };
}

describe('closedBars', () => {
  it('leaves out the newest bar until its period ends', () => {
    const bars = barsOf([1, 2, 3]);
    const last = bars[2] as Bar;
    expect(closedBars(bars, '1D', last.time + DAY - 1)).toHaveLength(2);
    expect(closedBars(bars, '1D', last.time + DAY)).toHaveLength(3);
    expect(closedBars([], '1D', T0)).toEqual([]);
  });
});

describe('evaluateIndicatorAlert', () => {
  it('the first check records the side of the newest closed bar and does not fire', () => {
    const bars = barsOf([90, 90, 90, 110, 110, 110]);
    const r = evaluateIndicatorAlert(smaCross(), bars, after(bars));
    expect(r.fires).toEqual([]);
    expect(r.state.lastSide).toBe('above');
    expect(r.state.lastBarTime).toBe((bars[5] as Bar).time);
  });

  it('fires when the line crosses the value on a closed bar', () => {
    // SMA(3): 90, 90, 90, 96.7, 103.3 → crosses 100 at bar 4.
    const r = runBars(smaCross(), [90, 90, 90, 100, 110], 3);
    expect(r.fires).toEqual([(bar(4, 0)).time]);
    expect(r.alert.status).toBe('triggered');
  });

  it('a forming bar does not fire, and the same bar fires once it is closed', () => {
    const base = barsOf([90, 90, 90]);
    let a = smaCross();
    a = { ...a, state: evaluateIndicatorAlert(a, base, after(base)).state };
    const forming = [...base, bar(3, 200)];
    const during = evaluateIndicatorAlert(a, forming, (forming[3] as Bar).time + DAY - 60);
    expect(during.fires).toEqual([]);
    expect(during.state.lastBarTime).toBe((base[2] as Bar).time);
    const closed = evaluateIndicatorAlert({ ...a, state: during.state }, forming, (forming[3] as Bar).time + DAY);
    expect(closed.fires).toHaveLength(1);
  });

  it('a forming bar that crosses and crosses back makes no event', () => {
    const base = barsOf([90, 90, 90]);
    let a = smaCross();
    a = { ...a, state: evaluateIndicatorAlert(a, base, after(base)).state };
    const spike = [...base, bar(3, 200)];
    const r1 = evaluateIndicatorAlert(a, spike, (spike[3] as Bar).time + 3600);
    a = { ...a, state: r1.state };
    const back = [...base, bar(3, 91)];
    const r2 = evaluateIndicatorAlert(a, back, after(back));
    expect([...r1.fires, ...r2.fires]).toEqual([]);
  });

  it('checks each new closed bar after a long gap, in order', () => {
    const every = smaCross('cross', { frequency: 'every' });
    const all = barsOf([90, 90, 90, 110, 110, 110, 90, 90, 90]);
    let a = { ...every, state: evaluateIndicatorAlert(every, all.slice(0, 3), after(all.slice(0, 3))).state };
    const r = evaluateIndicatorAlert(a, all, after(all));
    expect(r.fires.map((f) => f.crossed)).toEqual(['up', 'down']);
    a = { ...a, state: r.state };
    expect(a.state.firedCount).toBe(2);
  });

  it(`keeps at most ${MAX_FIRES_PER_CHECK} events from one check`, () => {
    const every = smaCross('cross', { frequency: 'every' });
    const closes = [90, 90, 90];
    for (let i = 0; i < 20; i++) closes.push(...(i % 2 === 0 ? [130, 130, 130] : [70, 70, 70]));
    const all = barsOf(closes);
    const a = { ...every, state: evaluateIndicatorAlert(every, all.slice(0, 3), after(all.slice(0, 3))).state };
    expect(evaluateIndicatorAlert(a, all, after(all)).fires).toHaveLength(MAX_FIRES_PER_CHECK);
  });

  it('no new closed bar: no fire, and the state keeps lastBarTime', () => {
    const bars = barsOf([90, 90, 90, 110]);
    const a = { ...smaCross(), state: { ...EMPTY, lastSide: 'below' as const, lastBarTime: (bars[3] as Bar).time } };
    const r = evaluateIndicatorAlert(a, bars, after(bars) + 10);
    expect(r.fires).toEqual([]);
    expect(r.state).toEqual({ ...a.state, lastCheckedAt: after(bars) + 10 });
  });

  it('skips warmup bars with no value', () => {
    const r = runBars(smaCross(), [200, 200, 90, 90, 90, 110, 110], 1);
    // SMA(3) has no value at bars 0–1. Its first value (163) only sets the side; it falls below 100 at bar 4.
    expect(r.fires).toEqual([bar(4, 0).time]);
  });

  it('compares with the close', () => {
    const a = alertOf({ type: 'indicator', timeframe: '1D', indicator: { kind: 'sma', params: { period: 3, source: 'close' } }, line: 'value', direction: 'up', target: { type: 'close' } });
    // Line above the close means "above". Falling closes push the SMA above the close.
    const r = runBars(a, [100, 100, 100, 101, 102, 90], 4);
    expect(r.fires).toEqual([bar(5, 0).time]);
  });

  it('compares MACD with its signal line', () => {
    const closes = [...Array.from({ length: 60 }, (_, i) => 100 - i * i * 0.01), ...Array.from({ length: 30 }, (_, i) => 64 + i * 2)];
    const a = alertOf(
      { type: 'indicator', timeframe: '1D', indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } }, line: 'macd', direction: 'up', target: { type: 'line', line: 'signal' } },
      { frequency: 'every' },
    );
    const r = runBars(a, closes, 40);
    expect(r.fires).toHaveLength(1);
    const t = r.fires[0] as number;
    expect(t).toBeGreaterThan(bar(60, 0).time);
    expect(t).toBeLessThan(bar(70, 0).time);
  });

  it('crossing down ignores a crossing up', () => {
    expect(runBars(smaCross('down'), [90, 90, 90, 100, 110], 3).fires).toEqual([]);
  });

  it('expiry wins over a crossing', () => {
    const bars = barsOf([90, 90, 90, 110, 110]);
    const a = { ...smaCross(), expiresAt: T0, state: { ...EMPTY, lastSide: 'below' as const, lastBarTime: (bars[2] as Bar).time } };
    const r = evaluateIndicatorAlert(a, bars, after(bars));
    expect(r.status).toBe('expired');
    expect(r.fires).toEqual([]);
  });
});

// ── Confluence alerts ──

const vbar = (i: number, close: number, volume = 1000, range: [number, number] = [close, close]): Bar => ({
  time: T0 + i * DAY, open: close, high: range[1], low: range[0], close, volume, vwap: null, transactions: null,
});
/** Volume average of 2 bars and a multiplier of 1.5: 4000 after 1000 passes, 1000 after 1000 does not. */
const confParams = (over: Partial<ConfluenceParams> = {}): ConfluenceParams => ({
  ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: T0, volumeLength: 2, volumeMult: 1.5, ...over,
});
type Lock = Extract<AlertCondition, { type: 'confluence' }>['lock'];
const LOCK: Lock = { bottom: 98, top: 100, count: 3, time: T0 };
const confluence = (over: Partial<ConfluenceParams> = {}, lock: Lock = LOCK, alert: Partial<Alert> = {}) =>
  alertOf({ type: 'confluence', timeframe: '1D', params: confParams(over), lock }, alert);
const HI = 4000;

/** Checks the bars step by step from `firstCheckAt` bars, as the scheduler does at each bar close. */
function runConfluence(alert: Alert, all: Bar[], firstCheckAt: number) {
  let a = alert;
  const fires: number[] = [];
  for (let n = firstCheckAt; n <= all.length; n++) {
    const bars = all.slice(0, n);
    const r = evaluateConfluenceAlert(a, bars, after(bars));
    fires.push(...r.fires.map((f) => f.time));
    a = { ...a, state: r.state, status: r.status };
  }
  return { alert: a, fires };
}
const timeOf = (i: number) => T0 + i * DAY;

describe('evaluateConfluenceAlert', () => {
  it('turn: the first check does not fire; a later close above the top with volume fires up', () => {
    const all = [vbar(0, 99), vbar(1, 99), vbar(2, 99), vbar(3, 101, HI)];
    const first = evaluateConfluenceAlert(confluence(), all.slice(0, 3), after(all.slice(0, 3)));
    expect(first.fires).toEqual([]);
    expect(first.state.lastSide).toBe('below');
    const r = evaluateConfluenceAlert({ ...confluence(), state: first.state }, all, after(all));
    expect(r.fires).toEqual([{ crossed: 'up', value: 101, target: 100, time: timeOf(3) }]);
    expect(r.status).toBe('triggered');
  });

  it('a close past the top on low volume does not fire; a later close with volume does, with no new crossing', () => {
    const all = [vbar(0, 99), vbar(1, 99), vbar(2, 101), vbar(3, 101.5, HI)];
    expect(runConfluence(confluence(), all, 2).fires).toEqual([timeOf(3)]);
  });

  it('every: fires again only after a close back below the top (the re-arm)', () => {
    const all = [vbar(0, 99), vbar(1, 99), vbar(2, 101, HI), vbar(3, 102, HI), vbar(4, 99), vbar(5, 99), vbar(6, 101, HI)];
    const r = runConfluence(confluence({}, LOCK, { frequency: 'every' }), all, 2);
    expect(r.fires).toEqual([timeOf(2), timeOf(6)]);
    expect(r.alert.status).toBe('active');
  });

  it('breakdown: fires down on a close below the top with volume and a close low in its range', () => {
    const params = { mode: 'breakdown' as const };
    // Bar 2 closes high in its range (98.9 of 95..99): no event. Bar 3 closes low in its range.
    const all = [vbar(0, 101), vbar(1, 101), vbar(2, 98.9, HI, [95, 99]), vbar(3, 99, HI * 4, [98.5, 103])];
    const r = runConfluence(confluence(params, LOCK, { frequency: 'every' }), all, 2);
    expect(r.fires).toEqual([timeOf(3)]);
    expect(r.alert.state.lastSide).toBe('below');
  });

  it('the first check replays from the lock bar: a break that the chart already marked does not fire again', () => {
    // The break at bar 2 is before the alert. Bar 4 stays above with volume: no event, as on the chart.
    const all = [vbar(0, 99), vbar(1, 99), vbar(2, 101, HI), vbar(3, 101), vbar(4, 102, HI), vbar(5, 99), vbar(6, 101, HI)];
    const r = runConfluence(confluence({}, LOCK, { frequency: 'every' }), all, 4);
    expect(r.fires).toEqual([timeOf(6)]);
  });

  it('ignores the bars before the lock bar, also when the lock bar was still forming at the first check', () => {
    const lock = { ...LOCK, time: timeOf(3) };
    const all = [vbar(0, 99), vbar(1, 101, HI), vbar(2, 99), vbar(3, 101, HI)];
    expect(runConfluence(confluence({}, lock), all, 3).fires).toEqual([timeOf(3)]);
  });

  it('expiry wins over an event', () => {
    const all = [vbar(0, 99), vbar(1, 99), vbar(2, 101, HI)];
    const a = confluence({}, LOCK, { expiresAt: T0, state: { ...EMPTY, lastSide: 'below', lastBarTime: timeOf(1) } });
    expect(evaluateConfluenceAlert(a, all, after(all))).toMatchObject({ status: 'expired', fires: [] });
  });

  // The alert must fire on the bars where the chart marks a latched event after the alert was made.
  // Seeds and latch bars chosen so that the chart has several latched events after the alert.
  it.each([
    ['turn', 42, 300],
    ['breakdown', 7, 350],
  ] as const)('%s: fires on the same bars as the latched events of the chart', (mode, seed, latchBar) => {
    const full = randomBars(700, seed, T0, DAY);
    const params: ConfluenceParams = { ...DEFAULT_PARAMS.confluence, mode, latch: 'on', latchTime: timeOf(latchBar) };
    const k = latchBar + 50; // the alert is made when bar k is the newest bar
    const atK = computeConfluence(full.slice(0, k + 1), params);
    const primary = atK.last?.primary;
    const lockBar = full[atK.latch.lockIndex ?? -1];
    if (!atK.latch.holds || !primary || !lockBar) throw new Error('the fixture must hold a lock at bar k');
    const alert = alertOf(
      { type: 'confluence', timeframe: '1D', params, lock: { bottom: primary.bottom, top: primary.top, count: primary.count, time: lockBar.time } },
      { frequency: 'every' },
    );
    const chart = computeConfluence(full, params).events.filter((e) => e.latched && e.index > k).map((e) => e.time);
    expect(chart.length).toBeGreaterThan(0);
    expect(runConfluence(alert, full, k + 1).fires).toEqual(chart);
  });
});

describe('evaluateAlert', () => {
  it('dispatches by condition type', () => {
    const p = { ...price(100), state: { ...EMPTY, lastSide: 'below' as const } };
    expect(evaluateAlert(p, { price: obs(101) }, T0).fires).toHaveLength(1);
    expect(evaluateAlert(p, {}, T0).fires).toEqual([]);
    expect(evaluateAlert(smaCross(), {}, T0).fires).toEqual([]);
    expect(evaluateAlert(confluence(), {}, T0).fires).toEqual([]);
  });
});
