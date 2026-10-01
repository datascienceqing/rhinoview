/**
 * Synthetic `MarketEngine`.
 *
 * Architecture (this is what makes invariant 2 hold by construction):
 *
 *   PricePath(symbol seed, path index)  →  1-minute OHLCV  →  bucket  →  Bar
 *
 * Every bar of every timeframe is an aggregation of the same minute bars, so a 1h bar
 * *is* the first/last/max/min/sum of its 5m bars, a 1D bar of its 1h bars, a 1W bar of
 * its 1D bars. Nothing is reconciled afterwards. Minute bars are computed on demand
 * from `(seed, slot * PATH_STRIDE + minute)`; no history is ever materialised, so a
 * bar's value cannot depend on what else was requested (invariant 1).
 *
 * Splits are applied to the aggregate, not generated per timeframe: the path is
 * defined in post-split terms, raw prices before a split are `price * ratio`, and the
 * adjusted series is `raw / ratio` (volume the other way). Adjustment is monotonic, so
 * it commutes with max/min and the coherence invariant survives it.
 */
import type { Bar, SearchResult, Snapshot, Timeframe, UnixSeconds } from '@shared/types';
import {
  civilToDay,
  dayStartUnix,
  mondayOf,
  nyDayOf,
  sessionMinutes,
  sessionOpenUnix,
  tradingSlot,
  isTradingDay,
} from './calendar';
import { MINUTE_VOL_FRACTION, PATH_STRIDE, PricePath, hash32, hashString } from './noise';
import { UnknownSymbolError } from './types';
import type { EngineBarsRequest, EngineBarsResult, EngineSymbol, MarketEngine } from './types';
import { UNIVERSE } from './universe';
import type { SplitEvent, SymbolModel } from './universe';

export interface SyntheticEngineOptions {
  /** Report data as delayed and lag snapshots by 15 minutes. Default false. */
  delayed?: boolean;
}

/** `SYNTHETIC_DELAYED` semantics: snapshots show the market as it was this long ago. */
const DELAY_SECONDS = 15 * 60;

/** Past this the engine has no opinion; also keeps `Date` arithmetic in range. */
const MAX_UNIX: UnixSeconds = Date.UTC(2100, 0, 1) / 1000;

/** Anchor: the path passes through each symbol's `basePrice` at this session's open. */
const ANCHOR_DAY = civilToDay(2026, 1, 2);

const BUCKET_MINUTES: Record<'1m' | '5m' | '15m' | '1h', number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };

const EARLY_CLOSE_VOLUME_FACTOR = 0.55;
const DAY_AGG_CACHE_LIMIT = 60_000;

/** Aggregated OHLCV in whichever price basis the caller is working in. */
interface Agg {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  transactions: number;
  /** Sum of volume * vwap. Invariant under split adjustment (price/f * volume*f). */
  pv: number;
}

interface DayContext {
  day: number;
  slot: number;
  minutes: number;
  /** Product of split ratios still ahead of this day; 1 after the last split. */
  factor: number;
  /** Expected raw shares per minute at shape 1, before per-minute noise. */
  volumeScale: number;
}

interface Unit {
  /** Bars this unit contributes to the requested range. */
  count: number;
  /** The most recent `take` of them, ascending. */
  build(take: number): Bar[];
}

class SymbolRuntime {
  readonly listedDay: number;
  readonly listedStart: UnixSeconds;
  readonly path: PricePath;
  readonly volSeed: number;
  readonly wickSeed: number;
  readonly tradeSeed: number;
  readonly daySeed: number;
  readonly lowerSymbol: string;
  readonly lowerName: string;

  constructor(
    readonly model: SymbolModel,
    readonly index: number,
  ) {
    const seed = hashString(model.symbol);
    this.listedDay = nyDayOf(model.listedAt);
    this.listedStart = dayStartUnix(this.listedDay);
    this.path = new PricePath(seed, model.basePrice, model.dailyVol, tradingSlot(ANCHOR_DAY) * PATH_STRIDE);
    this.volSeed = hash32(seed, 0xa1);
    this.wickSeed = hash32(seed, 0xa2);
    this.tradeSeed = hash32(seed, 0xa3);
    this.daySeed = hash32(seed, 0xa4);
    this.lowerSymbol = model.symbol.toLowerCase();
    this.lowerName = model.name.toLowerCase();
  }

  /** Product of the ratios of splits that take effect after `day`. */
  factorAt(day: number): number {
    let f = 1;
    for (const s of this.model.splits) if (s.day > day) f *= s.ratio;
    return f;
  }
}

// ── minute-level generation ─────────────────────────────────────────────────────

const roundCents = (x: number): number => Math.max(0.01, Math.round(x * 100) / 100);
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

const shapeCache = new Map<number, Float64Array>();

/**
 * Intraday volume profile, normalised to mean 1: a sharp spike at the open decaying
 * over ~20 minutes, a flat midday trough, and a ramp into the close. Defined relative
 * to the session length so a 13:00 early close ramps at 13:00, not at 16:00.
 */
function volumeShape(minutes: number): Float64Array {
  let shape = shapeCache.get(minutes);
  if (!shape) {
    shape = new Float64Array(minutes);
    let sum = 0;
    for (let t = 0; t < minutes; t++) {
      const v = 0.55 + 2.4 * Math.exp(-t / 18) + 1.5 * Math.exp(-(minutes - 1 - t) / 30);
      shape[t] = v;
      sum += v;
    }
    const mean = sum / minutes;
    for (let t = 0; t < minutes; t++) shape[t] = (shape[t] ?? 0) / mean;
    shapeCache.set(minutes, shape);
  }
  return shape;
}

function dayContext(rt: SymbolRuntime, day: number): DayContext {
  const minutes = sessionMinutes(day);
  const slot = tradingSlot(day);
  const factor = rt.factorAt(day);
  const h = hash32(rt.daySeed, slot);
  const z = ((h >>> 16) / 65536 + (h & 0xffff) / 65536 - 1) * 2.45; // Irwin-Hall(2) scaled to ~unit variance
  const dayFactor = Math.exp(0.3 * z - 0.045);
  const early = minutes === 210 ? EARLY_CLOSE_VOLUME_FACTOR : 1;
  return {
    day,
    slot,
    minutes,
    factor,
    volumeScale: ((rt.model.avgDailyVolume / 390) * dayFactor * early) / factor,
  };
}

/**
 * Aggregate session minutes [m0, m1) of one day into a single bar, with no per-minute
 * allocation. Within a session each minute's open is the previous minute's close (one
 * shared path sample); the overnight gap is the path's own movement across the stride.
 */
function aggregateMinutes(rt: SymbolRuntime, ctx: DayContext, m0: number, m1: number): Agg {
  const cursor = rt.path.cursor();
  const base = ctx.slot * PATH_STRIDE;
  const f = ctx.factor;
  const shape = volumeShape(ctx.minutes);
  const minuteVol = rt.model.dailyVol * MINUTE_VOL_FRACTION;
  const tradeSize = rt.model.tradeSize;

  let price = Math.exp(cursor.logPrice(base + m0));
  let open = 0;
  let high = -Infinity;
  let low = Infinity;
  let close = 0;
  let volume = 0;
  let transactions = 0;
  let pv = 0;

  for (let m = m0; m < m1; m++) {
    const next = Math.exp(cursor.logPrice(base + m + 1));
    const o = roundCents(price * f);
    const c = roundCents(next * f);
    price = next;

    const idx = base + m;
    const h1 = hash32(rt.volSeed, idx);
    const h2 = hash32(rt.wickSeed, idx);
    const h3 = hash32(rt.tradeSeed, idx);
    const u1 = (h1 >>> 16) / 65536;
    const u2 = (h1 & 0xffff) / 65536;
    const u3 = (h2 >>> 16) / 65536;
    const u4 = (h2 & 0xffff) / 65536;
    const u5 = (h3 >>> 16) / 65536;
    const u6 = (h3 & 0xffff) / 65536;

    const wick = Math.max(o, c) * minuteVol * 2.4;
    const hi = Math.max(o, c, roundCents(Math.max(o, c) + wick * u4 * u4));
    const lo = Math.min(o, c, roundCents(Math.min(o, c) - wick * u5 * u5));

    // u1+u2+u3 has mean 1.5 and variance 1/4: z is ~unit normal. exp(0.4z - 0.08) has mean 1.
    const z = (u1 + u2 + u3 - 1.5) * 2;
    const v = Math.round(ctx.volumeScale * (shape[m] ?? 1) * Math.exp(0.4 * z - 0.08));
    // Trade counts are not split-adjusted: scale back to post-split shares before dividing.
    const tx = v > 0 ? Math.max(1, Math.round((v * f) / (tradeSize * (0.6 + 0.8 * u6)))) : 0;
    const vwap = round4((o + hi + lo + c) / 4);

    if (m === m0) open = o;
    close = c;
    if (hi > high) high = hi;
    if (lo < low) low = lo;
    volume += v;
    transactions += tx;
    pv += v * vwap;
  }

  return { open, high, low, close, volume, transactions, pv };
}

/** Express a raw aggregate in post-split terms. Prices /f (4dp), volume *f. */
function adjustAgg(a: Agg, f: number): Agg {
  if (f === 1) return a;
  return {
    open: round4(a.open / f),
    high: round4(a.high / f),
    low: round4(a.low / f),
    close: round4(a.close / f),
    volume: a.volume * f,
    transactions: a.transactions,
    pv: a.pv,
  };
}

function combineAggs(aggs: readonly Agg[]): Agg {
  const first = aggs[0];
  const last = aggs[aggs.length - 1];
  if (!first || !last) throw new Error('combineAggs: empty');
  let high = first.high;
  let low = first.low;
  let volume = 0;
  let transactions = 0;
  let pv = 0;
  for (const a of aggs) {
    if (a.high > high) high = a.high;
    if (a.low < low) low = a.low;
    volume += a.volume;
    transactions += a.transactions;
    pv += a.pv;
  }
  return { open: first.open, high, low, close: last.close, volume, transactions, pv };
}

function aggToBar(time: UnixSeconds, a: Agg): Bar {
  return {
    time,
    open: a.open,
    high: a.high,
    low: a.low,
    close: a.close,
    volume: a.volume,
    vwap: a.volume > 0 ? round4(a.pv / a.volume) : a.close,
    transactions: a.transactions,
  };
}

// ── engine ───────────────────────────────────────────────────────────────────

export class SyntheticMarketEngine implements MarketEngine {
  readonly delayed: boolean;
  private readonly bySymbol = new Map<string, SymbolRuntime>();
  private readonly runtimes: readonly SymbolRuntime[];
  /**
   * Memo of raw full-session aggregates. Pure memoisation of a pure function: results
   * are identical with or without it (tested), it just makes 1D/1W requests cheap.
   */
  private readonly dayAggCache = new Map<number, Agg>();

  constructor(options: SyntheticEngineOptions = {}) {
    this.delayed = options.delayed ?? false;
    this.runtimes = UNIVERSE.map((m, i) => new SymbolRuntime(m, i));
    for (const rt of this.runtimes) this.bySymbol.set(rt.model.symbol, rt);
  }

  /** Every symbol in the universe (not part of the `MarketEngine` seam; for tooling and tests). */
  listSymbols(): EngineSymbol[] {
    return this.runtimes.map((rt) => this.publicSymbol(rt));
  }

  /** The synthetic splits of a symbol, ascending (not part of the seam). */
  getSplits(symbol: string): readonly SplitEvent[] {
    return this.lookup(symbol).model.splits;
  }

  resolveSymbol(symbol: string): EngineSymbol | undefined {
    const rt = this.bySymbol.get(symbol.trim().toUpperCase());
    return rt ? this.publicSymbol(rt) : undefined;
  }

  searchSymbols(query: string, limit: number): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q || !(limit >= 1)) return [];
    const hits: { rt: SymbolRuntime; rank: number }[] = [];
    for (const rt of this.runtimes) {
      const rank = matchRank(rt, q);
      if (rank >= 0) hits.push({ rt, rank });
    }
    hits.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.rt.model.symbol.length - b.rt.model.symbol.length ||
        (a.rt.model.symbol < b.rt.model.symbol ? -1 : 1),
    );
    return hits.slice(0, Math.floor(limit)).map(({ rt }) => ({
      symbol: rt.model.symbol,
      name: rt.model.name,
      exchange: rt.model.exchange,
      type: rt.model.type,
      currency: rt.model.currency,
      active: true,
    }));
  }

  getBars(req: EngineBarsRequest): EngineBarsResult {
    const rt = this.lookup(req.symbol);
    if (!Number.isFinite(req.from) || !Number.isFinite(req.to)) throw new RangeError('from/to must be finite');
    if (!Number.isFinite(req.limit) || req.limit < 1) throw new RangeError('limit must be >= 1');
    const limit = Math.floor(req.limit);

    const from = req.from;
    const to = Math.min(req.to, MAX_UNIX);
    // Invariant 4: nothing before listing. Checked on the raw range so it holds for
    // every timeframe, including a first partial week stamped with its Monday.
    if (to < from || to < rt.listedStart) return { bars: [], truncated: false };

    const dHi = nyDayOf(to);
    const dLo = Math.max(nyDayOf(Math.max(from, rt.listedStart - 8 * 86400)), rt.listedDay);

    const tf = req.timeframe;
    const units =
      tf === '1D'
        ? this.dailyUnits(rt, from, to, dLo, dHi, req.adjusted)
        : tf === '1W'
          ? this.weeklyUnits(rt, from, to, dHi, req.adjusted)
          : this.intradayUnits(rt, tf, from, to, dLo, dHi, req.adjusted);

    // Walk newest to oldest so `limit` keeps the window the user is looking at.
    const chunks: Bar[][] = [];
    let total = 0;
    let truncated = false;
    for (const unit of units) {
      const room = limit - total;
      if (room <= 0) {
        truncated = true;
        break;
      }
      if (unit.count > room) {
        chunks.push(unit.build(room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(unit.build(unit.count));
      total += unit.count;
    }

    const bars: Bar[] = [];
    for (let i = chunks.length - 1; i >= 0; i--) bars.push(...(chunks[i] ?? []));
    return { bars, truncated };
  }

  getSnapshot(symbol: string, asOf: UnixSeconds): Snapshot {
    const rt = this.lookup(symbol);
    if (!Number.isFinite(asOf)) throw new RangeError('asOf must be finite');

    const empty: Snapshot = {
      symbol: rt.model.symbol,
      price: null,
      change: null,
      changePercent: null,
      previousClose: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      dayVolume: null,
      updated: null,
      delayed: this.delayed,
    };

    // A delayed feed shows the market as it was 15 minutes ago.
    const effective = Math.min(asOf - (this.delayed ? DELAY_SECONDS : 0), MAX_UNIX);
    if (effective < rt.listedStart) return empty;

    let day = nyDayOf(effective);
    while (day >= rt.listedDay && !(isTradingDay(day) && sessionOpenUnix(day) <= effective)) day--;
    if (day < rt.listedDay) return empty;

    const ctx = dayContext(rt, day);
    const open = sessionOpenUnix(day);
    const completed = Math.min(ctx.minutes, Math.max(0, Math.floor((effective - open) / 60)));
    // No minute has completed yet (first seconds of the session): the opening print.
    const agg: Agg =
      completed > 0
        ? aggregateMinutes(rt, ctx, 0, completed)
        : (() => {
            const first = aggregateMinutes(rt, ctx, 0, 1);
            return { ...first, high: first.open, low: first.open, close: first.open, volume: 0, transactions: 0, pv: 0 };
          })();

    let previousClose: number | null = null;
    let prev = day - 1;
    while (prev >= rt.listedDay && !isTradingDay(prev)) prev--;
    if (prev >= rt.listedDay) {
      const prevFactor = rt.factorAt(prev);
      const raw = this.dayAgg(rt, prev).close;
      // Restate in today's share basis so a split overnight doesn't read as a -75% day.
      previousClose = prevFactor === ctx.factor ? raw : roundCents((raw / prevFactor) * ctx.factor);
    }

    const price = agg.close;
    const change = previousClose === null ? null : Math.round((price - previousClose) * 100) / 100;
    const changePercent =
      change === null || previousClose === null ? null : Math.round((change / previousClose) * 1e6) / 1e6;

    return {
      symbol: rt.model.symbol,
      price,
      change,
      changePercent,
      previousClose,
      dayOpen: agg.open,
      dayHigh: agg.high,
      dayLow: agg.low,
      dayVolume: agg.volume,
      updated: Math.min(effective, open + ctx.minutes * 60),
      delayed: this.delayed,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private lookup(symbol: string): SymbolRuntime {
    const rt = this.bySymbol.get(symbol.trim().toUpperCase());
    if (!rt) throw new UnknownSymbolError(symbol);
    return rt;
  }

  private publicSymbol(rt: SymbolRuntime): EngineSymbol {
    const { symbol, name, exchange, type, currency, listedAt } = rt.model;
    return { symbol, name, exchange, type, currency, listedAt };
  }

  private dayAgg(rt: SymbolRuntime, day: number): Agg {
    const key = rt.index * 100_000 + day;
    const hit = this.dayAggCache.get(key);
    if (hit) return hit;
    const ctx = dayContext(rt, day);
    const agg = aggregateMinutes(rt, ctx, 0, ctx.minutes);
    if (this.dayAggCache.size >= DAY_AGG_CACHE_LIMIT) {
      // Drop the oldest tenth. Insertion order, so this is cheap.
      let n = DAY_AGG_CACHE_LIMIT / 10;
      for (const k of this.dayAggCache.keys()) {
        this.dayAggCache.delete(k);
        if (--n <= 0) break;
      }
    }
    this.dayAggCache.set(key, agg);
    return agg;
  }

  /** Sessions newest-first. Each unit is one session's worth of buckets inside [from, to]. */
  private *intradayUnits(
    rt: SymbolRuntime,
    tf: Timeframe,
    from: UnixSeconds,
    to: UnixSeconds,
    dLo: number,
    dHi: number,
    adjusted: boolean,
  ): Generator<Unit> {
    const bucket = tf === '1m' || tf === '5m' || tf === '15m' || tf === '1h' ? BUCKET_MINUTES[tf] : 1;
    const step = bucket * 60;
    for (let day = dHi; day >= dLo; day--) {
      const minutes = sessionMinutes(day);
      if (minutes === 0) continue;
      const open = sessionOpenUnix(day);
      const buckets = Math.ceil(minutes / bucket);
      // Bucket k opens at open + k*step; keep those whose open time is inside the range.
      const kLo = Math.max(0, Math.ceil((from - open) / step));
      const kHi = Math.min(buckets - 1, Math.floor((to - open) / step));
      const count = kHi - kLo + 1;
      if (count <= 0) continue;
      yield {
        count,
        build: (take) => {
          const ctx = dayContext(rt, day);
          const bars: Bar[] = [];
          for (let k = kHi - take + 1; k <= kHi; k++) {
            const m0 = k * bucket;
            const agg = aggregateMinutes(rt, ctx, m0, Math.min(m0 + bucket, minutes));
            bars.push(aggToBar(open + k * step, adjusted ? adjustAgg(agg, ctx.factor) : agg));
          }
          return bars;
        },
      };
    }
  }

  private *dailyUnits(
    rt: SymbolRuntime,
    from: UnixSeconds,
    to: UnixSeconds,
    dLo: number,
    dHi: number,
    adjusted: boolean,
  ): Generator<Unit> {
    for (let day = dHi; day >= dLo; day--) {
      if (!isTradingDay(day)) continue;
      const time = dayStartUnix(day);
      if (time < from || time > to) continue;
      yield {
        count: 1,
        build: () => [aggToBar(time, this.adjustedDay(rt, day, adjusted))],
      };
    }
  }

  private *weeklyUnits(
    rt: SymbolRuntime,
    from: UnixSeconds,
    to: UnixSeconds,
    dHi: number,
    adjusted: boolean,
  ): Generator<Unit> {
    for (let monday = mondayOf(dHi); monday + 6 >= rt.listedDay; monday -= 7) {
      const time = dayStartUnix(monday);
      if (time > to) continue;
      if (time < from) return; // every earlier week is earlier still
      const days: number[] = [];
      for (let wd = 0; wd < 5; wd++) {
        const d = monday + wd;
        if (d >= rt.listedDay && isTradingDay(d)) days.push(d);
      }
      if (days.length === 0) continue;
      yield {
        count: 1,
        // Aggregate *adjusted* daily aggregates so a week straddling a split is coherent
        // with the adjusted daily bars it contains.
        build: () => [aggToBar(time, combineAggs(days.map((d) => this.adjustedDay(rt, d, adjusted))))],
      };
    }
  }

  private adjustedDay(rt: SymbolRuntime, day: number, adjusted: boolean): Agg {
    const raw = this.dayAgg(rt, day);
    return adjusted ? adjustAgg(raw, rt.factorAt(day)) : raw;
  }
}

/**
 * Lower is better, -1 is no match. Exact ticker, then prefixes (ticker, name start,
 * start of any word in the name), then substrings (ticker, name).
 */
function matchRank(rt: SymbolRuntime, q: string): number {
  if (rt.lowerSymbol === q) return 0;
  if (rt.lowerSymbol.startsWith(q)) return 1;
  if (rt.lowerName.startsWith(q)) return 2;
  if (rt.lowerName.split(/[\s,.&()-]+/).some((w) => w.startsWith(q))) return 3;
  if (rt.lowerSymbol.includes(q)) return 4;
  if (rt.lowerName.includes(q)) return 5;
  return -1;
}
