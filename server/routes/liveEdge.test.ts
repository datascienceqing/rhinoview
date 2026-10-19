/**
 * CONTRACT guarantee 5a: no bars from the future. The fake engine is deliberately
 * clockless, like the real one: it returns whole-bucket aggregates of its minutes,
 * stamped with the bucket's open, whatever "now" is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TIMEFRAMES } from '@shared/types';
import type { ApiResult, Bar, BarsResponse, IndicatorSeries, Timeframe } from '@shared/types';
import { buildServer } from '../index';
import { LIVE_SLACK_SECONDS, sliceForRequest } from '../provider/service';
import type { EngineBarsRequest, EngineBarsResult, MarketEngine } from '../market/types';

const DAY = 86_400;
const WEEK = 7 * DAY;
const SPAN: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '1D': DAY, '1W': WEEK };
const MONDAY0 = 4 * DAY; // 1970-01-05 00:00 UTC, a Monday

// 2023-11-13 is a Monday; 1_699_833_600 is its 00:00 UTC. "Sessions" run 09:00-17:00 UTC.
const MON = 1_699_833_600;
const SESSION_OPEN = 9 * 3_600;
const SESSION_CLOSE = 17 * 3_600;

const inSession = (t: number) => {
  const s = t % DAY;
  const dow = Math.floor((t - MONDAY0) / DAY) % 7; // 0 = Monday
  return dow < 5 && s >= SESSION_OPEN && s < SESSION_CLOSE;
};

function minuteBar(t: number): Bar {
  const m = t / 60;
  const open = 100 + (m % 7);
  const close = 100 + ((m + 3) % 7);
  return {
    time: t,
    open,
    close,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    volume: 10 + (m % 5),
    vwap: (open + close) / 2,
    transactions: 3,
  };
}

const bucketStart = (tf: Timeframe, t: number) =>
  tf === '1W' ? Math.floor((t - MONDAY0) / WEEK) * WEEK + MONDAY0 : Math.floor(t / SPAN[tf]) * SPAN[tf];

function aggregate(time: number, minutes: Bar[]): Bar {
  const first = minutes[0] as Bar;
  const last = minutes.at(-1) as Bar;
  const volume = minutes.reduce((a, m) => a + m.volume, 0);
  return {
    time,
    open: first.open,
    high: Math.max(...minutes.map((m) => m.high)),
    low: Math.min(...minutes.map((m) => m.low)),
    close: last.close,
    volume,
    vwap: minutes.reduce((a, m) => a + (m.vwap ?? 0) * m.volume, 0) / volume,
    transactions: minutes.reduce((a, m) => a + (m.transactions ?? 0), 0),
  };
}

function clocklessEngine() {
  const getBars = vi.fn((req: EngineBarsRequest): EngineBarsResult => {
    const all: Bar[] = [];
    for (let start = bucketStart(req.timeframe, req.from); start <= req.to; start += SPAN[req.timeframe]) {
      if (start < req.from) continue;
      const minutes: Bar[] = [];
      for (let t = start; t < start + SPAN[req.timeframe]; t += 60) if (inSession(t)) minutes.push(minuteBar(t));
      if (minutes.length) all.push(req.timeframe === '1m' ? (minutes[0] as Bar) : aggregate(start, minutes));
    }
    const bars = all.slice(Math.max(0, all.length - req.limit));
    return { bars, truncated: all.length > req.limit };
  });
  const engine: MarketEngine & { getBars: typeof getBars } = {
    supportedTimeframes: TIMEFRAMES,
    delayed: false,
    resolveSymbol: (s) => (s === 'AAPL' ? { symbol: 'AAPL', name: 'Apple', exchange: 'XNAS', type: 'CS', currency: 'USD', listedAt: 0 } : undefined),
    searchSymbols: () => [],
    getBars,
    getSnapshot: () => {
      throw new Error('unused');
    },
  };
  return engine;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(now: number, opts: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const engine = clocklessEngine();
  app = buildServer({ engine, now: () => now, ...opts });
  return { app, engine };
}

async function bars(a: FastifyInstance, tf: Timeframe, from: number, to: number) {
  const res = await a.inject({ method: 'GET', url: `/api/bars?symbol=AAPL&timeframe=${tf}&from=${from}&to=${to}` });
  const body = res.json<ApiResult<BarsResponse>>();
  if (!body.ok) throw new Error(`expected ok, got ${JSON.stringify(body.error)}`);
  return { status: res.statusCode, data: body.data };
}

const YEAR = 365 * DAY;
// Wednesday 2023-11-15 12:00 UTC, mid-session; the fake's minutes run to 17:00.
const NOON = MON + 2 * DAY + 12 * 3_600;
// "Now" is 90 s past noon: the 12:00 minute has completed, the 12:01 minute is in progress.
const NOW = NOON + 90;
const LAST_COMPLETED_MINUTE = NOON;
const IN_PROGRESS_MINUTE = NOON + 60;
const WED = MON + 2 * DAY;

const dayMinutes = (from: number, to: number) => {
  const out: Bar[] = [];
  for (let t = from; t <= to; t += 60) if (inSession(t)) out.push(minuteBar(t));
  return out;
};

describe('no bars after now (guarantee 5a)', () => {
  it.each<Timeframe>(['1m', '5m', '15m', '1h', '1D', '1W'])('%s: a range a year past now returns nothing dated after now', async (tf) => {
    const { app: a } = server(NOW);
    const { status, data } = await bars(a, tf, MON - 3 * DAY, NOW + YEAR);
    expect(status).toBe(200);
    expect(data.bars.length).toBeGreaterThan(0);
    expect(Math.max(...data.bars.map((b) => b.time))).toBeLessThanOrEqual(NOW);
  });

  it('clamps `to` before calling the engine', async () => {
    const { app: a, engine } = server(NOW);
    await bars(a, '1h', MON, NOW + YEAR);
    expect(engine.getBars.mock.calls[0]?.[0].to).toBe(NOW);
  });

  it('leaves a historical `to` alone', async () => {
    const { app: a, engine } = server(NOW);
    await bars(a, '1h', MON, MON + DAY);
    expect(engine.getBars.mock.calls[0]?.[0].to).toBe(MON + DAY);
  });

  it('returns ok:true with [] and does not call the engine when the whole range is in the future', async () => {
    const { app: a, engine } = server(NOW);
    const { status, data } = await bars(a, '1D', NOW + 1, NOW + YEAR);
    expect(status).toBe(200);
    expect(data).toMatchObject({ bars: [], truncated: false, cached: false });
    expect(engine.getBars).not.toHaveBeenCalled();
  });

  it('still reports an unknown symbol for an all-future range', async () => {
    const { app: a } = server(NOW);
    const res = await a.inject({ method: 'GET', url: `/api/bars?symbol=NOPE&timeframe=1D&from=${NOW + 1}&to=${NOW + DAY}` });
    expect(res.statusCode).toBe(404);
  });

  it('keeps truncated honest and keeps the newest bars when clamped and limited', async () => {
    const { app: a } = server(NOW, { maxBars: 5 });
    const { data } = await bars(a, '1h', MON - 3 * DAY, NOW + YEAR);
    expect(data.truncated).toBe(true);
    expect(data.bars).toHaveLength(5);
    // The newest hour that has begun is 12:00, partial; nothing later.
    expect(data.bars.at(-1)?.time).toBe(NOON);
  });

  it('is not truncated when the clamped range fits', async () => {
    const { app: a } = server(NOW);
    const { data } = await bars(a, '1h', MON, NOW + YEAR);
    expect(data.truncated).toBe(false);
  });

  it('drops any future bar an engine returns despite the clamped `to`', async () => {
    const engine = clocklessEngine();
    engine.getBars.mockImplementation(() => ({
      bars: [minuteBar(NOON - 60), minuteBar(NOON + 3_600), minuteBar(NOON + 7_200)],
      truncated: false,
    }));
    app = buildServer({ engine, now: () => NOW });
    const { data } = await bars(app, '1m', MON, NOW + YEAR);
    expect(data.bars.map((b) => b.time)).toEqual([NOON - 60]);
  });
});

describe('the forming bar ends at the last COMPLETED minute', () => {
  it('1m: the minute still in progress is excluded, not returned whole', async () => {
    const { app: a, engine } = server(NOW);
    const { data } = await bars(a, '1m', NOON - 3_600, NOW + YEAR);
    expect(data.bars.at(-1)?.time).toBe(LAST_COMPLETED_MINUTE);
    expect(data.bars.some((b) => b.time === IN_PROGRESS_MINUTE)).toBe(false);
    expect(engine.getBars.mock.calls[0]?.[0].to).toBe(NOW - 60);
  });

  it('1m: a minute becomes available exactly when it ends', async () => {
    const { app: a } = server(IN_PROGRESS_MINUTE); // 12:01:00, so 12:00 just completed
    const { data } = await bars(a, '1m', NOON - 3_600, IN_PROGRESS_MINUTE + 5);
    expect(data.bars.at(-1)?.time).toBe(LAST_COMPLETED_MINUTE);
    await app?.close();
    const before = server(IN_PROGRESS_MINUTE - 1); // 12:00:59, 12:00 still running
    const early = await bars(before.app, '1m', NOON - 3_600, IN_PROGRESS_MINUTE + 5);
    expect(early.data.bars.at(-1)?.time).toBe(NOON - 60);
  });

  it('1m: a range that only reaches into the in-progress minute is empty, not an error', async () => {
    const { app: a, engine } = server(NOW);
    const { status, data } = await bars(a, '1m', IN_PROGRESS_MINUTE, NOW + YEAR);
    expect(status).toBe(200);
    expect(data.bars).toEqual([]);
    expect(engine.getBars).not.toHaveBeenCalled();
  });

  it('1D: today\'s bar is rebuilt from completed minutes only (close is the last COMPLETED minute\'s)', async () => {
    const { app: a } = server(NOW);
    const { data } = await bars(a, '1D', MON, NOW + YEAR);
    const today = data.bars.at(-1) as Bar;
    expect(today.time).toBe(WED);
    const expected = aggregate(WED, dayMinutes(WED, NOW - 60));
    expect(today).toMatchObject({ open: expected.open, high: expected.high, low: expected.low, close: expected.close, volume: expected.volume, transactions: expected.transactions });
    expect(today.vwap).toBeCloseTo(expected.vwap ?? NaN, 3);
    expect(today.close).toBe(minuteBar(LAST_COMPLETED_MINUTE).close);
    expect(today.close).not.toBe(minuteBar(IN_PROGRESS_MINUTE).close);
    // And strictly less than the engine's whole-session aggregate.
    const full = aggregate(WED, dayMinutes(WED, WED + DAY - 60));
    expect(today.volume).toBeLessThan(full.volume);
  });

  it('1D: drops today\'s midnight-stamped bar during pre-market, when nothing has traded', async () => {
    const preMarket = WED + 3 * 3_600; // Wed 03:00
    const { app: a } = server(preMarket);
    const { data } = await bars(a, '1D', MON, preMarket + YEAR);
    expect(data.bars.map((b) => b.time)).toEqual([MON, MON + DAY]); // Mon, Tue; no Wed
  });

  it('1D: at the first instant of the session (no minute completed) the bar is dropped', async () => {
    const open = WED + SESSION_OPEN + 30; // 09:00:30, the 09:00 minute is in progress
    const { app: a } = server(open);
    const { data } = await bars(a, '1D', MON, open + YEAR);
    expect(data.bars.map((b) => b.time)).toEqual([MON, MON + DAY]);
  });

  it('1D: after the close the finished bar is kept exactly as the engine made it', async () => {
    const evening = WED + 20 * 3_600; // Wed 20:00, session over
    const { app: a, engine } = server(evening);
    const { data } = await bars(a, '1D', MON, evening + YEAR);
    const wed = data.bars.at(-1) as Bar;
    const engineWed = engine.getBars.mock.results[0]?.value.bars.at(-1) as Bar;
    expect(wed).toEqual(engineWed);
  });

  it('1W: the current week\'s bar (stamped Monday, in the past) excludes Thursday and Friday', async () => {
    const { app: a } = server(NOW);
    const { data } = await bars(a, '1W', MON - WEEK, NOW + YEAR);
    const thisWeek = data.bars.at(-1) as Bar;
    expect(thisWeek.time).toBe(MON);
    const expected = aggregate(MON, dayMinutes(MON, NOW - 60));
    expect(thisWeek.volume).toBe(expected.volume);
    expect(thisWeek.close).toBe(expected.close);
    const fullWeek = aggregate(MON, dayMinutes(MON, MON + WEEK - 60));
    expect(thisWeek.volume).toBeLessThan(fullWeek.volume);
    // The previous, completed week is untouched.
    expect(data.bars.at(-2)?.time).toBe(MON - WEEK);
  });

  it('1W: drops the current week on Monday pre-market, when the week has not traded', async () => {
    const monPre = MON + 3 * 3_600;
    const { app: a } = server(monPre);
    const { data } = await bars(a, '1W', MON - WEEK, monPre + YEAR);
    expect(data.bars.map((b) => b.time)).toEqual([MON - WEEK]);
  });

  it('intraday: the forming 1h bar ends at the last completed minute, not at now or the top of the next hour', async () => {
    const mid = NOON + 20 * 60 + 30; // 12:20:30; the 12:20 minute is in progress
    const { app: a } = server(mid);
    const { data } = await bars(a, '1h', MON, mid + YEAR);
    const forming = data.bars.at(-1) as Bar;
    expect(forming.time).toBe(NOON);
    expect(forming.close).toBe(minuteBar(NOON + 19 * 60).close);
    expect(forming.volume).toBe(aggregate(NOON, dayMinutes(NOON, NOON + 19 * 60)).volume);
  });

  it('applies to the oracle endpoint too: indicators never see a future bar', async () => {
    const { app: a } = server(NOW);
    const res = await a.inject({ method: 'GET', url: `/api/indicator?symbol=AAPL&timeframe=1h&from=${MON}&to=${NOW + YEAR}&kind=sma&period=2` });
    const body = res.json<ApiResult<IndicatorSeries>>();
    if (!body.ok) throw new Error('expected ok');
    const times = body.data.lines[0]?.points.map((p) => p.time) ?? [];
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW);
  });
});

describe('cache keys for live ("up to the present") requests', () => {
  // The only caller that exists anchors `to` at its own nowSeconds() and `from` at
  // `to - window`, so both move every second. These pin that the cache survives that.
  const clientLoad = (tf: Timeframe, now: number, span = 2 * DAY) => ({ from: now - span, to: now, tf });

  it('hits when `to` equals now (the value the client actually sends)', async () => {
    const { app: a, engine } = server(NOW);
    const q = clientLoad('1h', NOW);
    const first = await bars(a, q.tf, q.from, q.to);
    const second = await bars(a, q.tf, q.from, q.to);
    expect(first.data.cached).toBe(false);
    expect(second.data.cached).toBe(true);
    expect(engine.getBars).toHaveBeenCalledTimes(2); // the 1h fetch + the forming-bar rebuild, once
  });

  it('hits when `to` is a little BEHIND the server clock (client skew)', async () => {
    const { app: a } = server(NOW);
    await bars(a, '1h', NOW - 2 * DAY, NOW);
    const behind = await bars(a, '1h', NOW - 2 * DAY, NOW - 90);
    expect(behind.data.cached).toBe(true);
  });

  it.each<Timeframe>(['1m', '5m', '15m', '1h', '1D', '1W'])('%s: successive loads whose from/to tick forward every second share one entry', async (tf) => {
    let now = NOW;
    const engine = clocklessEngine();
    app = buildServer({ engine, now: () => now });
    const flags: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const q = clientLoad(tf, now, tf === '1W' ? 8 * WEEK : 3 * DAY);
      flags.push((await bars(app, tf, q.from, q.to)).data.cached);
      now += 1;
    }
    expect(flags).toEqual([false, true, true, true, true]);
  });

  it('serves each request only its own range even though the entry is a superset', async () => {
    // Minute-aligned from; a second request 30 s later snaps to the same entry (60 s granule).
    const fromA = NOON - 600;
    const { app: a } = server(NOW);
    const first = await bars(a, '1m', fromA, NOW);
    const second = await bars(a, '1m', fromA + 30, NOW);
    expect(first.data.bars[0]?.time).toBe(fromA);
    expect(second.data.cached).toBe(true);
    expect(second.data.bars[0]?.time).toBe(fromA + 60); // the fromA bar predates this request
    expect(second.data.bars).toEqual(first.data.bars.slice(1));
    expect(second.data.truncated).toBe(false);
  });

  it('shares one entry across different future `to` values (and across a ticking clock)', async () => {
    let now = NOW;
    const engine = clocklessEngine();
    app = buildServer({ engine, now: () => now });
    const first = await bars(app, '1h', MON, now + YEAR);
    now += 7;
    const second = await bars(app, '1h', MON, now + 2 * YEAR);
    const third = await bars(app, '1h', MON, now + DAY);
    expect(first.data.cached).toBe(false);
    expect(second.data.cached).toBe(true);
    expect(third.data.cached).toBe(true);
  });

  it('does not alias a genuinely historical `to` with the live entry', async () => {
    const { app: a } = server(NOW);
    const live = await bars(a, '1D', MON, NOW);
    const past = await bars(a, '1D', MON, MON + DAY); // two days before now
    expect(live.data.cached).toBe(false);
    expect(past.data.cached).toBe(false);
    expect(past.data.bars.map((b) => b.time)).toEqual([MON, MON + DAY]);
  });

  it('a `to` just outside the live slack is historical and keys on its own value', async () => {
    const { app: a, engine } = server(NOW);
    await bars(a, '1D', MON, NOW - LIVE_SLACK_SECONDS - 10);
    expect(engine.getBars.mock.calls[0]?.[0].to).toBe(NOW - LIVE_SLACK_SECONDS - 10);
  });

  it('keeps truncated true on a shared entry that the cap clipped', async () => {
    const fromA = NOON - 3_600;
    const { app: a } = server(NOW, { maxBars: 5 });
    const first = await bars(a, '1m', fromA, NOW); // clipped to the newest 5 completed minutes
    const second = await bars(a, '1m', fromA + 30, NOW);
    expect(first.data.truncated).toBe(true);
    expect(second.data.cached).toBe(true);
    expect(second.data.truncated).toBe(true);
    expect(second.data.bars).toEqual(first.data.bars);
  });
});

describe('sliceForRequest', () => {
  const mk = (times: number[], truncated: boolean): BarsResponse => ({
    symbol: 'AAPL',
    timeframe: '1m',
    adjusted: true,
    bars: times.map((t) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1, vwap: null, transactions: null })),
    truncated,
    cached: false,
  });

  it('is not truncated when a cap-clipped entry already holds everything the request asked for', () => {
    const view = sliceForRequest(mk([600, 660, 720], true), 600, 0);
    expect(view.truncated).toBe(false);
    expect(view.bars).toHaveLength(3);
  });

  it('is truncated when the request reaches back past a cap-clipped entry\'s oldest bar', () => {
    expect(sliceForRequest(mk([600, 660], true), 599, 0).truncated).toBe(true);
  });

  it('is truncated when the request asked for range older than an unclipped entry covers (narrowing)', () => {
    expect(sliceForRequest(mk([600, 660], false), 100, 540).truncated).toBe(true);
    expect(sliceForRequest(mk([600, 660], false), 560, 540).truncated).toBe(false);
  });
});
