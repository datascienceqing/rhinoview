import type { ApiError, Bar, BarsResponse, SearchResult, Snapshot, Timeframe } from '@shared/types';
import barsDaily from './fixtures/bars-AAPL-1D.json';
import bars5m from './fixtures/bars-AAPL-5m.json';
import searchAapl from './fixtures/search-aapl.json';
import snapshotAapl from './fixtures/snapshot-AAPL.json';

// JSON imports widen string literals (`timeframe: string`), so assert the contract
// shape once here.
const dailyTemplate = (barsDaily.data as unknown as BarsResponse).bars;
const sessionTemplate = (bars5m.data as unknown as BarsResponse).bars;

export const MOCK_AAPL_SNAPSHOT = snapshotAapl.data as unknown as Snapshot;
const aaplSearchResults = searchAapl.data.results as unknown as SearchResult[];

/**
 * Symbols that deliberately misbehave, so every error state is reachable from the
 * UI (type the symbol in the search box and select it) and testable.
 * Any other symbol that is not AAPL is UNKNOWN_SYMBOL (404), like the real proxy.
 */
export const MOCK_SYMBOLS = {
  ok: 'AAPL',
  /** 429 RATE_LIMITED with retryAfterSeconds. */
  rateLimited: 'LIMIT',
  /** 502 UPSTREAM_ERROR. */
  upstreamError: 'BOOM',
  /** Request fails at the network level (no HTTP response at all). */
  networkDown: 'OFFLINE',
} as const;

/** Search queries that fail instead of returning results. */
export const MOCK_SEARCH_TRIGGERS = {
  rateLimited: 'throttle',
  upstreamError: 'explode',
} as const;

export const MOCK_RATE_LIMIT_SECONDS = 12;

const errorSymbols: SearchResult[] = [
  { symbol: MOCK_SYMBOLS.rateLimited, name: 'Mock: always rate limited', exchange: 'XMCK', type: 'CS', currency: 'USD', active: true },
  { symbol: MOCK_SYMBOLS.upstreamError, name: 'Mock: always upstream error', exchange: 'XMCK', type: 'CS', currency: 'USD', active: true },
  { symbol: MOCK_SYMBOLS.networkDown, name: 'Mock: network failure', exchange: null, type: 'CS', currency: 'USD', active: true },
];

export const MOCK_CATALOGUE: readonly SearchResult[] = [...aaplSearchResults, ...errorSymbols];

export function searchCatalogue(q: string, limit: number): SearchResult[] {
  const needle = q.trim().toLowerCase();
  return MOCK_CATALOGUE.filter(
    (r) => r.symbol.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle),
  ).slice(0, limit);
}

export function apiError(code: ApiError['code'], message: string, retryAfterSeconds?: number): ApiError {
  return retryAfterSeconds === undefined ? { code, message } : { code, message, retryAfterSeconds };
}

/**
 * Resolve a user-supplied ticker the way the engine seam does: case-insensitively,
 * returning the canonical upper-case form (which the response then echoes). Only
 * AAPL has bars; the failure symbols resolve so they can misbehave; everything else,
 * including the search-only AAPL.MX, is unknown.
 */
export function resolveMockSymbol(raw: string): string | undefined {
  const upper = raw.toUpperCase();
  const known = [MOCK_SYMBOLS.ok, MOCK_SYMBOLS.rateLimited, MOCK_SYMBOLS.upstreamError, MOCK_SYMBOLS.networkDown];
  return known.find((s) => s === upper);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bars
//
// The fixtures are a fixed 2025-2026 snapshot, which goes stale: the client asks for
// "the last N days" relative to today, so pinned fixtures eventually fall out of every
// request window and the chart goes permanently empty. So the fixtures are treated as
// price *templates* and re-stamped onto the most recent trading days at request time:
//   - 1D: the 300 fixture daily bars, one per weekday, ending at the last completed
//     session, stamped 00:00 America/New_York (like the engine).
//   - 5m: the fixture session (78 bars from 09:30 ET) repeated over SESSION_DAYS
//     weekdays with a small deterministic per-day price shift so days differ.
//   - 15m / 1h: folded from 5m within each session, stamped at the bucket's open.
//   - 1W: folded from 1D, stamped at the New York Monday.
//   - 1m: no source, so genuinely empty (exercises the empty state).
// Approximations vs the real engine, deliberately: weekdays only (no holidays or
// half-days), and 1D is not the exact aggregate of the intraday bars.
//
// This file is the one place the mocks convert between milliseconds (JS Date) and
// seconds (the contract); no Bar.time is ever scaled anywhere else.
// ─────────────────────────────────────────────────────────────────────────────

const MS = 1000;
const DAY = 86_400;
const SESSION_DAYS = 120;
const SESSION_OPEN_SECONDS = 9 * 3600 + 30 * 60;
const SESSION_CLOSE_SECONDS = 16 * 3600;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface NyWall {
  dayNumber: number; // days since 1970-01-01 of the NY civil date
  secondOfDay: number;
}

function nyWall(unix: number): NyWall {
  const p: Record<string, number> = {};
  for (const part of nyFormat.formatToParts(new Date(unix * MS))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const { year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = p;
  return {
    dayNumber: Math.floor(Date.UTC(year, month - 1, day) / MS / DAY),
    secondOfDay: hour * 3600 + minute * 60 + second,
  };
}

/** Unix seconds of a wall-clock time in New York on civil day `dayNumber` (DST-correct). */
function nyWallToUnix(dayNumber: number, secondOfDay: number): number {
  const asUtc = dayNumber * DAY + secondOfDay;
  const offsetAt = (unix: number) => {
    const w = nyWall(unix);
    return w.dayNumber * DAY + w.secondOfDay - unix;
  };
  // Two passes settle the offset away from a DST edge; sessions never sit on one.
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/** 0 = Sunday ... 6 = Saturday. Day 0 (1970-01-01) was a Thursday. */
const weekdayOf = (dayNumber: number) => (dayNumber + 4) % 7;
const isWeekday = (dayNumber: number) => weekdayOf(dayNumber) >= 1 && weekdayOf(dayNumber) <= 5;
const mondayOf = (dayNumber: number) => dayNumber - (weekdayOf(dayNumber) - 1);

/** The newest session that has fully closed at `now`. */
function lastCompletedSession(now: number): number {
  const w = nyWall(now);
  let day = w.secondOfDay >= SESSION_CLOSE_SECONDS ? w.dayNumber : w.dayNumber - 1;
  while (!isWeekday(day)) day--;
  return day;
}

/** The `count` weekdays ending at `endDay`, oldest first. */
function weekdaysEnding(endDay: number, count: number): number[] {
  const days: number[] = [];
  for (let d = endDay; days.length < count; d--) if (isWeekday(d)) days.unshift(d);
  return days;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function shifted(bar: Bar, time: number, factor: number): Bar {
  return {
    ...bar,
    time,
    open: round2(bar.open * factor),
    high: round2(bar.high * factor),
    low: round2(bar.low * factor),
    close: round2(bar.close * factor),
    vwap: bar.vwap === null ? null : round2(bar.vwap * factor),
  };
}

/** Fold consecutive bars sharing a key into one OHLCV bar stamped `timeOf(key)`. */
function fold(bars: readonly Bar[], keyOf: (b: Bar, index: number) => number, timeOf: (key: number) => number): Bar[] {
  const out: Bar[] = [];
  let currentKey: number | null = null;
  bars.forEach((b, i) => {
    const key = keyOf(b, i);
    const last = out[out.length - 1];
    if (last && key === currentKey) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      last.transactions = (last.transactions ?? 0) + (b.transactions ?? 0);
      last.vwap = null; // not recoverable without per-bar notional; null is honest
    } else {
      currentKey = key;
      out.push({ ...b, time: timeOf(key) });
    }
  });
  return out;
}

type Series = Record<Timeframe, Bar[]>;

function buildSeries(lastSession: number): Series {
  const dailyDays = weekdaysEnding(lastSession, dailyTemplate.length);
  const daily = dailyTemplate.map((b, i) => ({ ...b, time: nyWallToUnix(dailyDays[i] ?? lastSession, 0) }));
  const dailyDayOf = dailyDays;

  const sessionDays = weekdaysEnding(lastSession, SESSION_DAYS);
  const intraday: Record<'5m' | '15m' | '1h', Bar[]> = { '5m': [], '15m': [], '1h': [] };
  sessionDays.forEach((day, dayIndex) => {
    const open = nyWallToUnix(day, SESSION_OPEN_SECONDS);
    const factor = 1 + (((dayIndex * 37) % 21) - 10) / 400; // +-2.5%, deterministic
    const bars = sessionTemplate.map((b, k) => shifted(b, open + k * 300, factor));
    intraday['5m'].push(...bars);
    for (const [tf, period] of [['15m', 900], ['1h', 3600]] as const) {
      intraday[tf].push(...fold(bars, (b) => Math.floor((b.time - open) / period), (k) => open + k * period));
    }
  });

  const weekly = fold(
    daily,
    (_b, i) => mondayOf(dailyDayOf[i] ?? lastSession),
    (monday) => nyWallToUnix(monday, 0),
  );

  return { '1m': [], '5m': intraday['5m'], '15m': intraday['15m'], '1h': intraday['1h'], '1D': daily, '1W': weekly };
}

let cached: { lastSession: number; series: Series } | null = null;

function seriesAt(now: number): Series {
  const lastSession = lastCompletedSession(now);
  if (cached?.lastSession !== lastSession) cached = { lastSession, series: buildSeries(lastSession) };
  return cached.series;
}

const wallClockSeconds = () => Math.floor(Date.now() / MS);

/**
 * Bars in [from, to], inclusive on both ends. Like the proxy, `to` is clamped to the
 * current time, so there are never bars after now.
 */
export function sliceBars(timeframe: Timeframe, from: number, to: number, now = wallClockSeconds()): Bar[] {
  const upper = Math.min(to, now);
  return seriesAt(now)[timeframe].filter((b) => b.time >= from && b.time <= upper);
}
