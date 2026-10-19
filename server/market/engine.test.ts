import { describe, expect, it } from 'vitest';
import type { Bar, Timeframe } from '@shared/types';
import { TIMEFRAMES } from '@shared/types';
import { createSyntheticEngine } from './index';
import { UnknownSymbolError } from './types';
import type { EngineBarsRequest } from './types';

const engine = createSyntheticEngine();

/** Literal UTC instant in Unix seconds. */
const utc = (y: number, m: number, d: number, h = 0, mi = 0, sec = 0): number =>
  Date.UTC(y, m - 1, d, h, mi, sec) / 1000;

/** Independent New York wall-clock reader, so calendar tests do not lean on the code under test. */
const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});
function ny(t: number): { date: string; minuteOfDay: number; second: number; weekday: string } {
  const p = Object.fromEntries(nyFormat.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute),
    second: Number(p.second),
    weekday: String(p.weekday),
  };
}

function bars(
  symbol: string,
  timeframe: Timeframe,
  from: number,
  to: number,
  extra: Partial<EngineBarsRequest> = {},
): Bar[] {
  return engine.getBars({ symbol, timeframe, from, to, adjusted: true, limit: 1_000_000, ...extra }).bars;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 1: determinism', () => {
  const from = utc(2025, 10, 1);
  const to = utc(2025, 12, 31);

  it.each(TIMEFRAMES)('returns deep-equal bars for the same %s request twice', (tf) => {
    const f = tf === '1m' ? utc(2025, 12, 1) : from;
    for (const adjusted of [true, false]) {
      expect(bars('AAPL', tf, f, to, { adjusted })).toEqual(bars('AAPL', tf, f, to, { adjusted }));
    }
  });

  it('returns identical bars from a brand-new engine instance (i.e. across process restarts)', () => {
    const other = createSyntheticEngine();
    for (const tf of TIMEFRAMES) {
      const f = tf === '1m' ? utc(2025, 12, 1) : from;
      const req = { symbol: 'TSLA', timeframe: tf, from: f, to, adjusted: true, limit: 1_000_000 } as const;
      expect(other.getBars(req)).toEqual(engine.getBars(req));
    }
  });

  it('is unaffected by whatever else was requested in between', () => {
    const fresh = createSyntheticEngine();
    const before = fresh.getBars({ symbol: 'MSFT', timeframe: '1h', from, to, adjusted: true, limit: 100_000 });
    for (const sym of ['AAPL', 'NVDA', 'KRNL']) {
      for (const tf of TIMEFRAMES) fresh.getBars({ symbol: sym, timeframe: tf, from: 0, to: utc(2026, 1, 1), adjusted: false, limit: 50 });
    }
    fresh.getSnapshot('MSFT', utc(2025, 11, 12, 16));
    expect(fresh.getBars({ symbol: 'MSFT', timeframe: '1h', from, to, adjusted: true, limit: 100_000 })).toEqual(before);
  });

  describe('a sub-range equals the matching slice of a wider range (what lazy history loading does)', () => {
    // Deliberately starts and ends mid-session and mid-bucket, spans a weekend and Thanksgiving.
    const subFrom = utc(2025, 11, 20, 15, 7);
    const subTo = utc(2025, 12, 2, 18, 41);
    it.each(TIMEFRAMES)('%s', (tf) => {
      for (const adjusted of [true, false]) {
        const wide = bars('AAPL', tf, utc(2025, 11, 1), utc(2025, 12, 31), { adjusted });
        const narrow = bars('AAPL', tf, subFrom, subTo, { adjusted });
        const slice = wide.filter((b) => b.time >= subFrom && b.time <= subTo);
        expect(narrow.length).toBeGreaterThan(0);
        expect(narrow).toEqual(slice);
      }
    });

    it('also holds when the sub-range straddles a split', () => {
      const wide = bars('TSLA', '1D', utc(2022, 7, 1), utc(2022, 10, 1), { adjusted: true });
      const narrow = bars('TSLA', '1D', utc(2022, 8, 24, 12), utc(2022, 8, 26, 12), { adjusted: true });
      expect(narrow).toEqual(wide.filter((b) => b.time >= utc(2022, 8, 24, 12) && b.time <= utc(2022, 8, 26, 12)));
      expect(narrow.length).toBe(2);
    });
  });

  it('keeps prices stable over time (pinned golden bars: any change here corrupts every cached chart)', () => {
    expect(bars('AAPL', '1D', utc(2025, 11, 17), utc(2025, 11, 19))[0]).toEqual({
      time: 1763355600,
      open: 221.05,
      high: 222.21,
      low: 218.64,
      close: 221.94,
      volume: 60222245,
      vwap: 220.6584,
      transactions: 573714,
    });
    // from === to === the bar's open: also pins that both ends are inclusive.
    expect(bars('AAPL', '5m', 1763391300, 1763391300)[0]).toEqual({
      time: 1763391300,
      open: 221.14,
      high: 221.21,
      low: 220.7,
      close: 220.72,
      volume: 1332832,
      vwap: 220.9965,
      transactions: 12278,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 2: cross-timeframe coherence', () => {
  /** [child, parent, parent span in seconds that contains exactly that parent's children]. */
  const pairs: [Timeframe, Timeframe, number][] = [
    ['1m', '5m', 300],
    ['5m', '15m', 900],
    ['5m', '1h', 3600],
    ['15m', '1h', 3600],
    ['1h', '4h', 14400],
    ['4h', '1D', 86400],
    ['1h', '1D', 86400],
    ['1D', '1W', 6 * 86400], // Mon-Fri midnights, never the next Monday, whatever DST did
  ];

  function expectCoherent(child: Bar[], parent: Bar[], span: number): void {
    expect(parent.length).toBeGreaterThan(0);
    let covered = 0;
    for (const p of parent) {
      const kids = child.filter((c) => c.time >= p.time && c.time < p.time + span);
      const first = kids[0];
      const last = kids[kids.length - 1];
      expect(first, `no children for parent @${p.time}`).toBeDefined();
      if (!first || !last) return;
      covered += kids.length;
      expect(p.open, `open @${p.time}`).toBe(first.open);
      expect(p.close, `close @${p.time}`).toBe(last.close);
      expect(p.high, `high @${p.time}`).toBe(Math.max(...kids.map((k) => k.high)));
      expect(p.low, `low @${p.time}`).toBe(Math.min(...kids.map((k) => k.low)));
      expect(p.volume, `volume @${p.time}`).toBe(kids.reduce((s, k) => s + k.volume, 0));
      expect(p.transactions, `transactions @${p.time}`).toBe(kids.reduce((s, k) => s + (k.transactions ?? 0), 0));
      // vwap is a volume-weighted mean of rounded child vwaps; equal up to that rounding.
      const pv = kids.reduce((s, k) => s + k.volume * (k.vwap ?? 0), 0);
      expect(p.vwap ?? 0).toBeCloseTo(pv / p.volume, 3);
    }
    expect(covered, 'every child belongs to exactly one parent').toBe(child.length);
  }

  // Thanksgiving week: a holiday (27 Nov) and an early close (28 Nov) inside the window.
  const windows: [string, string, number, number][] = [
    // Ranges start at 00:00Z on a Monday and end after a Friday so every parent bar (stamped
    // at New York midnight / Monday) and all of its children fall inside the request.
    ['AAPL', 'across Thanksgiving + early close', utc(2025, 11, 17), utc(2025, 12, 6)],
    ['MSFT', 'across the March 2025 DST change', utc(2025, 3, 3), utc(2025, 3, 22)],
    ['NVDA', 'across the 2024-06-10 split', utc(2024, 6, 3), utc(2024, 6, 22)],
    ['TSLA', 'across a mid-week split (2022-08-25)', utc(2022, 8, 15), utc(2022, 9, 3)],
  ];

  for (const [symbol, label, from, to] of windows) {
    for (const adjusted of [true, false]) {
      for (const [childTf, parentTf, span] of pairs) {
        it(`${symbol} ${label}, adjusted=${adjusted}: ${childTf} aggregates exactly into ${parentTf}`, () => {
          expectCoherent(bars(symbol, childTf, from, to, { adjusted }), bars(symbol, parentTf, from, to, { adjusted }), span);
        });
      }
    }
  }

  it('also holds end to end: 1m aggregates into 1W', () => {
    const from = utc(2025, 11, 17);
    const to = utc(2025, 11, 22);
    const week = bars('AAPL', '1W', from, to)[0];
    const minutes = bars('AAPL', '1m', from, to);
    expect(week).toBeDefined();
    if (!week) return;
    expect(week.open).toBe(minutes[0]?.open);
    expect(week.close).toBe(minutes[minutes.length - 1]?.close);
    expect(week.high).toBe(Math.max(...minutes.map((m) => m.high)));
    expect(week.low).toBe(Math.min(...minutes.map((m) => m.low)));
    expect(week.volume).toBe(minutes.reduce((s, m) => s + m.volume, 0));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 3: market calendar (through the engine)', () => {
  const closed2025 = new Set([
    '2025-01-01',
    '2025-01-09',
    '2025-01-20',
    '2025-02-17',
    '2025-04-18',
    '2025-05-26',
    '2025-06-19',
    '2025-07-04',
    '2025-09-01',
    '2025-11-27',
    '2025-12-25',
  ]);
  const early2025 = new Set(['2025-07-03', '2025-11-28', '2025-12-24']);

  // One shared full-year pull: 250 sessions of 1m bars is ~98k bars. Wall-clock parts are
  // computed once and every scan below collects violations instead of asserting per bar.
  const year1m = bars('AAPL', '1m', utc(2025, 1, 1), utc(2025, 12, 31, 23));
  const parts = year1m.map((b) => ny(b.time));
  const byDate = new Map<string, number[]>();
  for (const p of parts) {
    const list = byDate.get(p.date) ?? [];
    list.push(p.minuteOfDay);
    byDate.set(p.date, list);
  }

  it('has bars on exactly the 250 sessions of 2025', () => {
    expect(byDate.size).toBe(250);
  });

  it('has no bar on a weekend or a holiday', () => {
    const bad = parts.filter((p) => p.weekday === 'Sat' || p.weekday === 'Sun' || closed2025.has(p.date));
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it('has no bar outside 09:30-16:00 New York, and every bar sits on a whole minute', () => {
    const bad = parts.filter((p) => p.minuteOfDay < 9 * 60 + 30 || p.minuteOfDay >= 16 * 60 || p.second !== 0);
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it('gives a normal session 390 one-minute bars (09:30..15:59) and an early close 210 (..12:59)', () => {
    const bad: string[] = [];
    for (const [date, minutes] of byDate) {
      const early = early2025.has(date);
      const wantCount = early ? 210 : 390;
      const wantLast = early ? 12 * 60 + 59 : 15 * 60 + 59;
      if (minutes.length !== wantCount || minutes[0] !== 570 || minutes[minutes.length - 1] !== wantLast) {
        bad.push(`${date}: ${minutes.length} bars, ${minutes[0]}..${minutes[minutes.length - 1]}`);
      }
    }
    expect(bad).toEqual([]);
    for (const d of early2025) expect(byDate.has(d), `${d} is a session`).toBe(true);
  });

  it('opens the last 5m bar of a normal session at 15:55 and has no 16:00 bar', () => {
    const five = bars('AAPL', '5m', utc(2025, 3, 11, 12), utc(2025, 3, 11, 23));
    expect(five.length).toBe(78);
    const times = five.map((b) => ny(b.time).minuteOfDay);
    expect(times[times.length - 1]).toBe(15 * 60 + 55);
    expect(times).not.toContain(16 * 60);
  });

  it('stops early-close days at 13:00: last 5m bar opens 12:55, last 1h bar opens 12:30', () => {
    const five = bars('AAPL', '5m', utc(2025, 11, 28, 12), utc(2025, 11, 28, 23));
    expect(five.length).toBe(42);
    expect(ny(five[five.length - 1]?.time ?? 0).minuteOfDay).toBe(12 * 60 + 55);
    const hourly = bars('AAPL', '1h', utc(2025, 11, 28, 12), utc(2025, 11, 28, 23));
    expect(hourly.map((b) => ny(b.time).minuteOfDay)).toEqual([570, 630, 690, 750]);
  });

  it('lays a normal day out as two 4h bars, 09:30 and 13:30, and an early-close day as one', () => {
    const normal = bars('AAPL', '4h', utc(2025, 3, 11, 12), utc(2025, 3, 11, 23));
    expect(normal.map((b) => ny(b.time).minuteOfDay)).toEqual([570, 810]);
    const early = bars('AAPL', '4h', utc(2025, 11, 28, 12), utc(2025, 11, 28, 23));
    expect(early.map((b) => ny(b.time).minuteOfDay)).toEqual([570]);
  });

  it('lays a normal day out as 09:30, 10:30, ... 15:30 hourly bars (last one is a half hour)', () => {
    const hourly = bars('AAPL', '1h', utc(2025, 3, 11, 12), utc(2025, 3, 11, 23));
    expect(hourly.map((b) => ny(b.time).minuteOfDay)).toEqual([570, 630, 690, 750, 810, 870, 930]);
  });

  it('opens at 09:30 New York in January and in July although the UTC time differs by an hour', () => {
    const jan = bars('AAPL', '1m', utc(2025, 1, 15, 12), utc(2025, 1, 15, 23))[0];
    const jul = bars('AAPL', '1m', utc(2025, 7, 16, 12), utc(2025, 7, 16, 23))[0];
    expect(jan && ny(jan.time).minuteOfDay).toBe(570);
    expect(jul && ny(jul.time).minuteOfDay).toBe(570);
    // Literal oracles: EST is UTC-5, EDT is UTC-4.
    expect(jan?.time).toBe(utc(2025, 1, 15, 14, 30));
    expect(jul?.time).toBe(utc(2025, 7, 16, 13, 30));
  });

  it('stays at 09:30 New York on both sides of the spring-forward and fall-back weekends', () => {
    const cases: [number, number][] = [
      [utc(2025, 3, 7, 12), utc(2025, 3, 7, 14, 30)], // Fri before spring forward: EST
      [utc(2025, 3, 10, 12), utc(2025, 3, 10, 13, 30)], // Mon after: EDT
      [utc(2025, 10, 31, 12), utc(2025, 10, 31, 13, 30)], // Fri before fall back: EDT
      [utc(2025, 11, 3, 12), utc(2025, 11, 3, 14, 30)], // Mon after: EST
    ];
    for (const [from, expectedOpen] of cases) {
      const first = bars('AAPL', '1h', from, from + 86400)[0];
      expect(first?.time).toBe(expectedOpen);
      expect(first && ny(first.time).minuteOfDay).toBe(570);
    }
  });

  it('stamps every 1D bar at 00:00 New York, and 1W bars at their Monday 00:00 New York', () => {
    const daily = bars('AAPL', '1D', utc(2025, 1, 1), utc(2025, 12, 31, 12));
    expect(daily.length).toBe(250);
    const badDaily = daily.map((b) => ny(b.time)).filter((p) => p.minuteOfDay !== 0 || p.second !== 0 || p.weekday === 'Sat' || p.weekday === 'Sun');
    expect(badDaily).toEqual([]);
    expect(bars('AAPL', '1D', utc(2025, 1, 15), utc(2025, 1, 15, 12))[0]?.time).toBe(utc(2025, 1, 15, 5));
    expect(bars('AAPL', '1D', utc(2025, 7, 16), utc(2025, 7, 16, 12))[0]?.time).toBe(utc(2025, 7, 16, 4));

    const weekly = bars('AAPL', '1W', utc(2025, 1, 1), utc(2025, 12, 31));
    expect(weekly.length).toBeGreaterThan(50);
    expect(weekly.map((b) => ny(b.time)).filter((p) => p.weekday !== 'Mon' || p.minuteOfDay !== 0)).toEqual([]);
    expect(bars('AAPL', '1W', utc(2025, 3, 10), utc(2025, 3, 10, 12))[0]?.time).toBe(utc(2025, 3, 10, 4)); // EDT
    expect(bars('AAPL', '1W', utc(2025, 3, 3), utc(2025, 3, 3, 12))[0]?.time).toBe(utc(2025, 3, 3, 5)); // EST
  });

  it('has a 1D bar for the Friday before a Saturday New Year and none for an observed Monday holiday', () => {
    expect(bars('AAPL', '1D', utc(2021, 12, 31), utc(2021, 12, 31, 12)).length).toBe(1);
    expect(bars('AAPL', '1D', utc(2022, 12, 26), utc(2022, 12, 26, 12)).length).toBe(0);
    expect(bars('AAPL', '1D', utc(2026, 7, 3), utc(2026, 7, 3, 12)).length).toBe(0);
  });

  it('weekly bars cover a holiday week with the sessions that exist', () => {
    const w = bars('AAPL', '1W', utc(2025, 11, 24), utc(2025, 11, 24, 12));
    const days = bars('AAPL', '1D', utc(2025, 11, 24), utc(2025, 11, 29));
    expect(days.length).toBe(4); // Mon, Tue, Wed, Fri (Thanksgiving Thursday closed)
    expect(w.length).toBe(1);
    expect(w[0]?.volume).toBe(days.reduce((s, b) => s + b.volume, 0));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 4: no invented history', () => {
  const recent = engine.listSymbols().filter((s) => s.listedAt > utc(2025, 1, 1));

  it('has at least three recently listed symbols (thin-history path is reachable)', () => {
    expect(recent.length).toBeGreaterThanOrEqual(3);
  });

  for (const tf of TIMEFRAMES) {
    it(`returns a successful empty answer for a ${tf} range entirely before listedAt`, () => {
      for (const s of recent) {
        const result = engine.getBars({
          symbol: s.symbol,
          timeframe: tf,
          from: s.listedAt - 60 * 86400,
          to: s.listedAt - 1,
          adjusted: true,
          limit: 5000,
        });
        expect(result, s.symbol).toEqual({ bars: [], truncated: false });
      }
    });
  }

  it('returns an empty answer for ranges far before listing, even at the epoch', () => {
    expect(engine.getBars({ symbol: 'KRNL', timeframe: '1D', from: 0, to: 86400, adjusted: true, limit: 10 })).toEqual({
      bars: [],
      truncated: false,
    });
  });

  it('starts a range that straddles listing at the first listed session, with nothing earlier', () => {
    const krnl = engine.resolveSymbol('KRNL');
    expect(krnl).toBeDefined();
    if (!krnl) return;
    const wide = { from: krnl.listedAt - 400 * 86400, to: utc(2026, 10, 1, 12) };
    for (const tf of ['1m', '5m', '15m', '1h', '1D'] as const) {
      const got = bars('KRNL', tf, wide.from, wide.to);
      expect(got.length, tf).toBeGreaterThan(0);
      expect(got[0]?.time, tf).toBeGreaterThanOrEqual(krnl.listedAt);
      for (const b of got) expect(b.time).toBeGreaterThanOrEqual(krnl.listedAt);
    }
    const daily = bars('KRNL', '1D', wide.from, wide.to);
    expect(daily[0]?.time).toBe(krnl.listedAt);
    // 24, 25, 28, 29, 30 September and 1 October 2026.
    expect(daily.length).toBe(6);
  });

  it('only includes listed sessions in the first, partial week (stamped with its Monday)', () => {
    const krnl = engine.resolveSymbol('KRNL');
    if (!krnl) throw new Error('KRNL missing');
    const weekly = bars('KRNL', '1W', krnl.listedAt - 30 * 86400, utc(2026, 10, 1, 12));
    expect(weekly.length).toBe(2);
    expect(weekly[0]?.time).toBe(utc(2026, 9, 21, 4)); // Monday of the listing week
    const daily = bars('KRNL', '1D', krnl.listedAt - 30 * 86400, utc(2026, 9, 27));
    expect(weekly[0]?.volume).toBe(daily.reduce((s, b) => s + b.volume, 0)); // Thu + Fri only
  });

  it('treats an inverted range as empty rather than an error', () => {
    expect(engine.getBars({ symbol: 'AAPL', timeframe: '1D', from: 2000, to: 1000, adjusted: true, limit: 10 })).toEqual({
      bars: [],
      truncated: false,
    });
  });

  it('survives absurd ranges without hanging or throwing', () => {
    const r = engine.getBars({ symbol: 'AAPL', timeframe: '1D', from: -1e15, to: 1e15, adjusted: true, limit: 5 });
    expect(r.bars.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 5: plausible prices and volume', () => {
  /** Problems found in one bar. Collected rather than `expect`ed per bar: 100k bars x 12 expects is minutes. */
  function problems(b: Bar): string[] {
    const out: string[] = [];
    for (const k of ['open', 'high', 'low', 'close'] as const) {
      if (!Number.isFinite(b[k]) || b[k] <= 0) out.push(`${k} not finite and > 0: ${b[k]}`);
    }
    if (b.low > Math.min(b.open, b.close)) out.push('low > min(open, close)');
    if (b.high < Math.max(b.open, b.close)) out.push('high < max(open, close)');
    if (!Number.isInteger(b.volume) || b.volume < 0) out.push(`volume not a non-negative integer: ${b.volume}`);
    if (b.vwap === null) out.push('vwap null');
    else if (b.vwap < b.low || b.vwap > b.high) out.push('vwap outside [low, high]');
    if (b.transactions === null || !Number.isInteger(b.transactions) || b.transactions < 0) out.push('transactions invalid');
    return out;
  }

  function allProblems(label: string, list: Bar[]): string[] {
    expect(list.length, `${label} returned bars`).toBeGreaterThan(0);
    const out: string[] = [];
    for (const b of list) {
      for (const p of problems(b)) {
        if (out.length < 5) out.push(`${label} @${b.time}: ${p}`);
      }
    }
    return out;
  }

  it('holds for every bar of a full year of 1m data, and for 5y of daily bars', () => {
    expect(allProblems('AAPL 1m 2025', bars('AAPL', '1m', utc(2025, 1, 1), utc(2025, 12, 31, 23)))).toEqual([]);
    expect(allProblems('TSLA 1D raw', bars('TSLA', '1D', utc(2020, 1, 1), utc(2025, 1, 1), { adjusted: false }))).toEqual([]);
  });

  it('holds for every symbol, timeframe and adjustment mode', () => {
    const found: string[] = [];
    for (const s of engine.listSymbols()) {
      for (const tf of TIMEFRAMES) {
        const from = tf === '1W' || tf === '1D' ? utc(2026, 7, 1) : utc(2026, 9, 21);
        for (const adjusted of [true, false]) {
          found.push(...allProblems(`${s.symbol} ${tf} adjusted=${adjusted}`, bars(s.symbol, tf, from, utc(2026, 9, 30), { adjusted })));
        }
      }
    }
    expect(found.slice(0, 5)).toEqual([]);
  });

  it('shows the intraday volume U-shape: heavy open, light midday, heavy close', () => {
    for (const symbol of ['AAPL', 'JPM', 'SOLQ']) {
      const five = bars(symbol, '5m', utc(2026, 6, 15), utc(2026, 9, 25));
      const sum = new Map<number, { total: number; n: number }>();
      for (const b of five) {
        const m = ny(b.time).minuteOfDay;
        const e = sum.get(m) ?? { total: 0, n: 0 };
        e.total += b.volume;
        e.n++;
        sum.set(m, e);
      }
      const avg = (from: number, to: number): number => {
        let t = 0;
        let n = 0;
        for (const [m, e] of sum) {
          if (m >= from && m < to) {
            t += e.total;
            n += e.n;
          }
        }
        return t / n;
      };
      const open = avg(9 * 60 + 30, 9 * 60 + 45);
      const midday = avg(12 * 60, 13 * 60 + 30);
      const close = avg(15 * 60 + 45, 16 * 60);
      expect(open / midday, `${symbol} open/midday`).toBeGreaterThan(2.5);
      expect(close / midday, `${symbol} close/midday`).toBeGreaterThan(1.8);
      // Monotone-ish descent after the open and ascent into the close.
      expect(avg(10 * 60, 10 * 60 + 15)).toBeLessThan(open);
      expect(avg(15 * 60, 15 * 60 + 15)).toBeGreaterThan(midday);
    }
  });

  it('puts the close ramp of an early-close day at 13:00, not 16:00', () => {
    const five = bars('AAPL', '5m', utc(2025, 11, 28, 12), utc(2025, 11, 28, 23));
    const vol = five.map((b) => b.volume);
    const midday = vol.slice(12, 24).reduce((a, b) => a + b, 0) / 12; // 10:30-11:30
    expect(vol[vol.length - 1] ?? 0).toBeGreaterThan(midday * 1.8);
  });

  it('moves like a stock: realized daily volatility is within 35% of the symbol parameter', () => {
    const expected: Record<string, number> = { AAPL: 0.016, TSLA: 0.036, JNJ: 0.009 };
    for (const [symbol, vol] of Object.entries(expected)) {
      const closes = bars(symbol, '1D', utc(2022, 1, 1), utc(2025, 1, 1)).map((b) => b.close);
      const rets = closes.slice(1).map((c, i) => Math.log(c / (closes[i] ?? c)));
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      expect(sd / vol, symbol).toBeGreaterThan(0.65);
      expect(sd / vol, symbol).toBeLessThan(1.35);
    }
  });

  it('has overnight gaps but no gaps inside a session', () => {
    const minutes = bars('AAPL', '1m', utc(2025, 3, 10, 12), utc(2025, 3, 14, 23));
    let inSessionGaps = 0;
    let overnightGaps = 0;
    for (let i = 1; i < minutes.length; i++) {
      const a = minutes[i - 1];
      const b = minutes[i];
      if (!a || !b) continue;
      const sameDay = ny(a.time).date === ny(b.time).date;
      if (sameDay && a.close !== b.open) inSessionGaps++;
      if (!sameDay && a.close !== b.open) overnightGaps++;
    }
    expect(inSessionGaps).toBe(0);
    expect(overnightGaps).toBe(4);
  });

  it('keeps long-run prices in a believable band around the symbol level', () => {
    for (const s of ['AAPL', 'KO', 'SPY']) {
      const closes = bars(s, '1W', utc(2005, 1, 1), utc(2026, 9, 30)).map((b) => b.close);
      expect(Math.min(...closes)).toBeGreaterThan(1);
      expect(Math.max(...closes) / Math.min(...closes)).toBeLessThan(60);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 6: splits', () => {
  const withSplits = engine.listSymbols().filter((s) => engine.getSplits(s.symbol).length > 0);

  it('carries synthetic splits on at least two symbols, one of them with two', () => {
    expect(withSplits.length).toBeGreaterThanOrEqual(2);
    expect(withSplits.some((s) => engine.getSplits(s.symbol).length >= 2)).toBe(true);
  });

  it('shows the discontinuity unadjusted and a continuous series adjusted, for every split', () => {
    for (const s of withSplits) {
      for (const split of engine.getSplits(s.symbol)) {
        const splitMidnight = utc(1970, 1, 1) + split.day * 86400; // UTC midnight of the civil date
        const from = splitMidnight - 6 * 86400;
        const to = splitMidnight + 6 * 86400;
        const raw = bars(s.symbol, '1D', from, to, { adjusted: false });
        const adj = bars(s.symbol, '1D', from, to, { adjusted: true });
        const i = raw.findIndex((b) => b.time >= splitMidnight);
        expect(i, `${s.symbol} split index`).toBeGreaterThan(0);
        const rawBefore = raw[i - 1];
        const rawAfter = raw[i];
        const adjBefore = adj[i - 1];
        const adjAfter = adj[i];
        if (!rawBefore || !rawAfter || !adjBefore || !adjAfter) throw new Error('missing bars');

        const rawGap = Math.log(rawAfter.open / rawBefore.close);
        const adjGap = Math.log(adjAfter.open / adjBefore.close);
        // Overnight sigma is ~1-2%; a split is -ln(ratio) <= -0.69.
        expect(rawGap, `${s.symbol} raw gap`).toBeLessThan(-Math.log(split.ratio) + 0.2);
        expect(rawGap, `${s.symbol} raw gap`).toBeGreaterThan(-Math.log(split.ratio) - 0.2);
        expect(Math.abs(adjGap), `${s.symbol} adjusted gap`).toBeLessThan(0.2);
      }
    }
  });

  it('divides pre-split prices and multiplies pre-split volume by the ratio; post-split is untouched', () => {
    const tsla = engine.getSplits('TSLA');
    expect(tsla.map((x) => x.ratio)).toEqual([5, 3]);
    const from = utc(2022, 8, 15);
    const to = utc(2022, 9, 2);
    const raw = bars('TSLA', '1D', from, to, { adjusted: false });
    const adj = bars('TSLA', '1D', from, to, { adjusted: true });
    expect(adj.length).toBe(raw.length);
    let pre = 0;
    let post = 0;
    raw.forEach((r, i) => {
      const a = adj[i];
      if (!a) throw new Error('missing');
      if (r.time < utc(2022, 8, 25, 4)) {
        pre++;
        expect(a.open).toBe(round4(r.open / 3));
        expect(a.high).toBe(round4(r.high / 3));
        expect(a.low).toBe(round4(r.low / 3));
        expect(a.close).toBe(round4(r.close / 3));
        expect(a.volume).toBe(r.volume * 3);
        expect(a.transactions).toBe(r.transactions); // trade counts are not split-adjusted
      } else {
        post++;
        expect(a).toEqual(r);
      }
    });
    expect(pre).toBeGreaterThan(0);
    expect(post).toBeGreaterThan(0);
  });

  it('compounds two splits: before both, the factor is 5 * 3 = 15', () => {
    const raw = bars('TSLA', '1D', utc(2019, 6, 3), utc(2019, 6, 8), { adjusted: false });
    const adj = bars('TSLA', '1D', utc(2019, 6, 3), utc(2019, 6, 8), { adjusted: true });
    expect(raw.length).toBe(5);
    raw.forEach((r, i) => {
      expect(adj[i]?.close).toBe(round4(r.close / 15));
      expect(adj[i]?.volume).toBe(r.volume * 15);
    });
  });

  it('is deterministic in both modes, including from a fresh engine', () => {
    const fresh = createSyntheticEngine();
    for (const adjusted of [true, false]) {
      for (const tf of ['1h', '1D', '1W'] as const) {
        const req = { symbol: 'NVDA', timeframe: tf, from: utc(2024, 5, 1), to: utc(2024, 7, 1), adjusted, limit: 100_000 } as const;
        expect(engine.getBars(req)).toEqual(engine.getBars(req));
        expect(fresh.getBars(req)).toEqual(engine.getBars(req));
      }
    }
  });

  it('makes adjusted and unadjusted identical for a symbol with no splits', () => {
    expect(bars('AAPL', '1D', utc(2024, 1, 1), utc(2025, 1, 1), { adjusted: true })).toEqual(
      bars('AAPL', '1D', utc(2024, 1, 1), utc(2025, 1, 1), { adjusted: false }),
    );
  });

  it('leaves a week that straddles a split as mixed-basis when unadjusted and coherent when adjusted', () => {
    const [rawWeek] = bars('TSLA', '1W', utc(2022, 8, 22), utc(2022, 8, 22, 12), { adjusted: false });
    const [adjWeek] = bars('TSLA', '1W', utc(2022, 8, 22), utc(2022, 8, 22, 12), { adjusted: true });
    if (!rawWeek || !adjWeek) throw new Error('missing week');
    expect(rawWeek.high / rawWeek.low).toBeGreaterThan(2.5); // pre-split highs vs post-split lows
    expect(adjWeek.high / adjWeek.low).toBeLessThan(1.4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('invariant 7: ordering', () => {
  for (const tf of TIMEFRAMES) {
    it(`returns ${tf} bars strictly increasing with no duplicates`, () => {
      for (const [symbol, from, to] of [
        ['AAPL', tf === '1m' ? utc(2025, 11, 1) : utc(2020, 1, 1), utc(2025, 12, 31)],
        ['TSLA', tf === '1m' ? utc(2022, 8, 1) : utc(2019, 1, 1), utc(2022, 10, 1)], // spans both splits
        ['KRNL', utc(2026, 1, 1), utc(2026, 10, 1)], // thin history
      ] as const) {
        const got = bars(symbol, tf, from, to);
        expect(got.length).toBeGreaterThan(0);
        for (let i = 1; i < got.length; i++) {
          expect(got[i]?.time ?? 0, `${symbol} ${tf} index ${i}`).toBeGreaterThan(got[i - 1]?.time ?? Infinity);
        }
      }
    });
  }

  it('stays ascending when the limit clips the oldest bars', () => {
    const got = bars('AAPL', '1m', utc(2025, 11, 1), utc(2025, 12, 31), { limit: 1234 });
    expect(got.length).toBe(1234);
    for (let i = 1; i < got.length; i++) expect(got[i]?.time ?? 0).toBeGreaterThan(got[i - 1]?.time ?? Infinity);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('limit and truncation: the most recent `limit` bars win', () => {
  const from = utc(2025, 1, 1);
  const to = utc(2025, 12, 31);

  for (const tf of TIMEFRAMES) {
    it(`${tf}: clips to the newest bars and reports truncated`, () => {
      const f = tf === '1m' || tf === '5m' ? utc(2025, 11, 1) : from;
      const all = bars('AAPL', tf, f, to);
      const limit = Math.min(37, all.length - 1);
      const clipped = engine.getBars({ symbol: 'AAPL', timeframe: tf, from: f, to, adjusted: true, limit });
      expect(clipped.truncated).toBe(true);
      expect(clipped.bars).toEqual(all.slice(-limit));
    });
  }

  it('reports truncated: false when the limit exactly fits, and when it exceeds the range', () => {
    const all = bars('AAPL', '1D', from, to);
    const exact = engine.getBars({ symbol: 'AAPL', timeframe: '1D', from, to, adjusted: true, limit: all.length });
    expect(exact.truncated).toBe(false);
    expect(exact.bars).toEqual(all);
    const roomy = engine.getBars({ symbol: 'AAPL', timeframe: '1D', from, to, adjusted: true, limit: all.length + 100 });
    expect(roomy.truncated).toBe(false);
    expect(roomy.bars).toEqual(all);
    const one = engine.getBars({ symbol: 'AAPL', timeframe: '1D', from, to, adjusted: true, limit: all.length - 1 });
    expect(one.truncated).toBe(true);
  });

  it('can cut in the middle of a session and still return the newest bars', () => {
    const all = bars('AAPL', '5m', utc(2025, 11, 3), utc(2025, 11, 5, 23));
    const clipped = engine.getBars({ symbol: 'AAPL', timeframe: '5m', from: utc(2025, 11, 3), to: utc(2025, 11, 5, 23), adjusted: true, limit: 100 });
    expect(clipped.bars).toEqual(all.slice(-100));
    expect(clipped.truncated).toBe(true);
  });

  it('is not truncated when the clipped-away range simply has no bars (weekend before the window)', () => {
    // from is on a weekend: nothing older exists inside the range, so nothing was clipped.
    const r = engine.getBars({ symbol: 'AAPL', timeframe: '1D', from: utc(2025, 3, 8), to: utc(2025, 3, 14, 23), adjusted: true, limit: 5 });
    expect(r.bars.length).toBe(5);
    expect(r.truncated).toBe(false);
  });

  it('does not truncate a thin-history symbol that has fewer bars than the limit', () => {
    const r = engine.getBars({ symbol: 'KRNL', timeframe: '1D', from: 0, to: utc(2026, 10, 1, 12), adjusted: true, limit: 5000 });
    expect(r.bars.length).toBe(6);
    expect(r.truncated).toBe(false);
  });

  it('rejects a nonsensical limit instead of returning garbage', () => {
    expect(() => engine.getBars({ symbol: 'AAPL', timeframe: '1D', from, to, adjusted: true, limit: 0 })).toThrow(RangeError);
    expect(() => engine.getBars({ symbol: 'AAPL', timeframe: '1D', from: Number.NaN, to, adjusted: true, limit: 5 })).toThrow(RangeError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('unknown symbols', () => {
  it('getBars throws UnknownSymbolError carrying the symbol', () => {
    const req = { symbol: 'NOPE', timeframe: '1D', from: 0, to: 1, adjusted: true, limit: 1 } as const;
    expect(() => engine.getBars(req)).toThrow(UnknownSymbolError);
    try {
      engine.getBars(req);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSymbolError);
      expect((e as UnknownSymbolError).symbol).toBe('NOPE');
    }
  });

  it('getSnapshot throws UnknownSymbolError', () => {
    expect(() => engine.getSnapshot('NOPE', utc(2025, 1, 1))).toThrow(UnknownSymbolError);
  });

  it('is case-insensitive for known symbols', () => {
    expect(engine.getBars({ symbol: 'aapl', timeframe: '1D', from: utc(2025, 3, 10), to: utc(2025, 3, 13), adjusted: true, limit: 10 }).bars.length).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('resolveSymbol and the universe', () => {
  it('resolves case-insensitively to the canonical upper-case form, undefined when unknown', () => {
    expect(engine.resolveSymbol('aapl')?.symbol).toBe('AAPL');
    expect(engine.resolveSymbol(' brk.b ')?.symbol).toBe('BRK.B');
    expect(engine.resolveSymbol('NOPE')).toBeUndefined();
    expect(engine.resolveSymbol('')).toBeUndefined();
  });

  it('has several dozen symbols across both exchanges, both types, USD', () => {
    const all = engine.listSymbols();
    expect(all.length).toBeGreaterThanOrEqual(36);
    expect(new Set(all.map((s) => s.exchange))).toEqual(new Set(['XNAS', 'XNYS']));
    expect(new Set(all.map((s) => s.type))).toEqual(new Set(['CS', 'ETF']));
    expect(new Set(all.map((s) => s.currency))).toEqual(new Set(['USD']));
    expect(new Set(all.map((s) => s.symbol)).size).toBe(all.length);
  });

  it('does not let a caller mutate the universe through a returned symbol', () => {
    const s = engine.resolveSymbol('AAPL');
    if (!s) throw new Error('missing');
    s.name = 'tampered';
    expect(engine.resolveSymbol('AAPL')?.name).toBe('Apple Inc.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('searchSymbols', () => {
  const syms = (q: string, limit = 50): string[] => engine.searchSymbols(q, limit).map((r) => r.symbol);

  it('ranks an exact ticker match first, even when other tickers/names merely contain it', () => {
    expect(syms('GS')[0]).toBe('GS');
    expect(syms('gs')[0]).toBe('GS');
    expect(syms('GS').length).toBeGreaterThan(1); // PYPL ("Holdings") matches by substring
    expect(syms('f')[0]).toBe('F');
    expect(syms('t')[0]).toBe('T');
  });

  it('ranks ticker prefix, name prefix, name word prefix, ticker substring, name substring', () => {
    // "co": COST (ticker prefix) < CMCSA ("Comcast", name prefix) < KO ("Coca-Cola": word prefix)
    //       < QCOM (ticker substring) < AVGO ("Broadcom": name substring only)
    const r = syms('co');
    expect(r[0]).toBe('COST');
    expect(r[1]).toBe('CMCSA');
    expect(r.indexOf('KO')).toBeGreaterThan(1);
    expect(r.indexOf('QCOM')).toBeGreaterThan(r.indexOf('KO'));
    expect(r.indexOf('AVGO')).toBeGreaterThan(r.indexOf('QCOM'));
  });

  it('puts shorter tickers first within the same tier ("ba": BA before BAC)', () => {
    expect(syms('ba').slice(0, 2)).toEqual(['BA', 'BAC']);
  });

  it('matches on name when the ticker does not match', () => {
    expect(syms('bank')).toContain('BAC');
    expect(syms('motor')).toEqual(expect.arrayContaining(['F', 'GM']));
    expect(syms('energy')).toContain('XLE');
    expect(syms('semiconductor')).toContain('SMH');
    expect(syms('alphabet')).toEqual(['GOOGL']);
    expect(syms('berkshire')).toEqual(['BRK.B']);
    for (const q of ['bank', 'motor', 'energy', 'semiconductor', 'alphabet', 'berkshire']) {
      for (const s of syms(q)) expect(s.toLowerCase()).not.toBe(q); // genuinely not ticker hits
    }
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(syms('  ALPHABET ')).toEqual(['GOOGL']);
    expect(syms('BANK')).toEqual(syms('bank'));
  });

  it('returns an empty array, never an error, when nothing matches', () => {
    expect(engine.searchSymbols('zzzzqqq', 10)).toEqual([]);
    expect(engine.searchSymbols('', 10)).toEqual([]);
    expect(engine.searchSymbols('   ', 10)).toEqual([]);
  });

  it('honours the limit', () => {
    expect(engine.searchSymbols('a', 3).length).toBe(3);
    expect(engine.searchSymbols('a', 0)).toEqual([]);
  });

  it('returns well-formed SearchResults', () => {
    expect(engine.searchSymbols('AAPL', 1)).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'XNAS', type: 'CS', currency: 'USD', active: true },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
describe('getSnapshot', () => {
  const afterClose = utc(2025, 11, 20, 23); // Thursday 18:00 New York

  it('after the close equals that session’s 1D bar, with previousClose from the prior session', () => {
    const [prior, today] = bars('AAPL', '1D', utc(2025, 11, 19), utc(2025, 11, 20, 12));
    if (!prior || !today) throw new Error('missing bars');
    const s = engine.getSnapshot('AAPL', afterClose);
    expect(s).toMatchObject({
      symbol: 'AAPL',
      price: today.close,
      dayOpen: today.open,
      dayHigh: today.high,
      dayLow: today.low,
      dayVolume: today.volume,
      previousClose: prior.close,
      delayed: false,
    });
    expect(s.updated).toBe(utc(2025, 11, 20, 21)); // 16:00 New York (EST)
  });

  it('expresses changePercent as a fraction, not a percentage', () => {
    for (const sym of ['AAPL', 'TSLA', 'KO', 'SPY']) {
      const s = engine.getSnapshot(sym, afterClose);
      if (s.change === null || s.previousClose === null || s.changePercent === null || s.price === null) throw new Error('nulls');
      expect(s.change).toBeCloseTo(s.price - s.previousClose, 2);
      expect(s.changePercent).toBeCloseTo(s.change / s.previousClose, 5);
      expect(Math.abs(s.changePercent)).toBeLessThan(0.3); // 0.0123, not 1.23
    }
  });

  it('derives from the same path as the bars: mid-session it equals the aggregate of completed minutes', () => {
    const asOf = utc(2025, 11, 20, 17, 12, 30); // 12:12:30 New York: minutes through 12:11 are complete
    const minutes = bars('AAPL', '1m', utc(2025, 11, 20, 12), asOf).filter((b) => b.time + 60 <= asOf);
    const s = engine.getSnapshot('AAPL', asOf);
    expect(minutes.length).toBe(162);
    expect(s.price).toBe(minutes[minutes.length - 1]?.close);
    expect(s.dayOpen).toBe(minutes[0]?.open);
    expect(s.dayHigh).toBe(Math.max(...minutes.map((m) => m.high)));
    expect(s.dayLow).toBe(Math.min(...minutes.map((m) => m.low)));
    expect(s.dayVolume).toBe(minutes.reduce((t, m) => t + m.volume, 0));
    expect(s.updated).toBe(asOf);
  });

  it('honours asOf rather than the clock: different times give different answers, same time the same', () => {
    const a = engine.getSnapshot('AAPL', utc(2025, 11, 20, 16));
    const b = engine.getSnapshot('AAPL', utc(2025, 11, 20, 19));
    expect(a).not.toEqual(b);
    expect(engine.getSnapshot('AAPL', utc(2025, 11, 20, 16))).toEqual(a);
    expect(engine.getSnapshot('AAPL', utc(2020, 6, 1, 16)).price).not.toBe(a.price);
  });

  it('shows the last session over a weekend and over a holiday', () => {
    const fri = engine.getSnapshot('AAPL', utc(2025, 11, 21, 22));
    expect(engine.getSnapshot('AAPL', utc(2025, 11, 23, 15))).toEqual(fri);
    // Thursday 27 Nov was Thanksgiving: Friday 28 Nov early close, previous close is Wednesday's.
    const wed = bars('AAPL', '1D', utc(2025, 11, 26), utc(2025, 11, 26, 12))[0];
    const afterHoliday = engine.getSnapshot('AAPL', utc(2025, 11, 28, 20));
    expect(afterHoliday.previousClose).toBe(wed?.close);
    expect(afterHoliday.updated).toBe(utc(2025, 11, 28, 18)); // 13:00 New York
  });

  it('reports the opening print when asked in the first seconds of a session', () => {
    const s = engine.getSnapshot('AAPL', utc(2025, 11, 20, 14, 30, 20));
    expect(s.price).toBe(s.dayOpen);
    expect(s.dayVolume).toBe(0);
  });

  it('restates the previous close in post-split terms on the first day after a split', () => {
    const s = engine.getSnapshot('TSLA', utc(2022, 8, 25, 21));
    if (s.changePercent === null) throw new Error('null');
    expect(Math.abs(s.changePercent)).toBeLessThan(0.2); // not -66%
    const [pre] = bars('TSLA', '1D', utc(2022, 8, 24), utc(2022, 8, 24, 12), { adjusted: true });
    expect(s.previousClose).toBeCloseTo(pre?.close ?? 0, 1);
  });

  it('has no previous close on a symbol’s first session, and nothing at all before listing', () => {
    const first = engine.getSnapshot('KRNL', utc(2026, 9, 24, 22));
    expect(first.price).not.toBeNull();
    expect(first.previousClose).toBeNull();
    expect(first.change).toBeNull();
    expect(first.changePercent).toBeNull();
    const before = engine.getSnapshot('KRNL', utc(2026, 9, 1));
    expect(before).toEqual({
      symbol: 'KRNL',
      price: null,
      change: null,
      changePercent: null,
      previousClose: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      dayVolume: null,
      updated: null,
      delayed: false,
    });
  });

  it('flags delayed data and shows the market as it was 15 minutes earlier', () => {
    const delayed = createSyntheticEngine({ delayed: true });
    expect(delayed.delayed).toBe(true);
    expect(engine.delayed).toBe(false);
    const asOf = utc(2025, 11, 20, 17, 12, 30);
    const d = delayed.getSnapshot('AAPL', asOf);
    expect(d.delayed).toBe(true);
    expect(d.updated).toBe(asOf - 900);
    expect({ ...d, delayed: false }).toEqual({ ...engine.getSnapshot('AAPL', asOf - 900), delayed: false });
  });

  it('clamps an asOf far beyond the engine horizon instead of throwing', () => {
    expect(engine.getSnapshot('AAPL', 1e12).updated).not.toBeNull();
    expect(() => engine.getSnapshot('AAPL', Number.NaN)).toThrow(RangeError);
  });
});
