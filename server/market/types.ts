/**
 * MARKET ENGINE SEAM — the interface between the data engine and the HTTP layer.
 *
 * ORCHESTRATOR-OWNED. Frozen. Two workers are building against this file in
 * parallel: one implements `MarketEngine` in `server/market/`, the other consumes it
 * from `server/provider/` and `server/routes/`. An unilateral edit here breaks the
 * other one silently. If a type is wrong or missing, stop and report it.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS SEAM EXISTS
 *
 * There is no market-data subscription yet. The synthetic engine stands in for one.
 * A real massive.com client will later implement this same interface, selected by
 * `DATA_PROVIDER` in `server/env.ts`, with no change to routes or to the client.
 *
 * The engine's job is bars, symbols and snapshots. It knows nothing about HTTP,
 * caching, rate limits, or the `ApiResult` envelope — those belong to the layer above.
 * ──────────────────────────────────────────────────────────────────────────────
 */
import type { Bar, Snapshot, SearchResult, Timeframe, UnixSeconds } from '@shared/types';

/** A symbol in the engine's universe. */
export interface EngineSymbol {
  /** Ticker, e.g. "AAPL". Compared case-insensitively, returned in canonical upper case. */
  symbol: string;
  name: string;
  exchange: string;
  /** e.g. "CS" (common stock), "ETF". */
  type: string;
  currency: string;
  /**
   * First session with data, Unix seconds. Requests for bars before this return
   * nothing — the engine must not invent pre-listing history. Several symbols in the
   * universe should have recent listing dates so the "thin history" path is reachable.
   */
  listedAt: UnixSeconds;
}

export interface EngineBarsRequest {
  /** Canonical symbol. The caller has already resolved and validated it. */
  symbol: string;
  timeframe: Timeframe;
  /** Inclusive, Unix seconds. */
  from: UnixSeconds;
  /** Inclusive, Unix seconds. */
  to: UnixSeconds;
  /** Apply split adjustment. Defaults to true at the HTTP layer. */
  adjusted: boolean;
  /**
   * Hard cap on returned bars. The engine returns the **most recent** `limit` bars
   * within the range and reports `truncated: true`, so that a chart asking for an
   * absurd range still gets the window the user is actually looking at.
   */
  limit: number;
}

export interface EngineBarsResult {
  bars: Bar[];
  /** True when `limit` clipped the result. */
  truncated: boolean;
}

/**
 * Thrown by the engine for conditions the HTTP layer maps onto contract error codes.
 * The engine never throws for an empty-but-valid range — that is an empty array.
 */
export class UnknownSymbolError extends Error {
  constructor(public readonly symbol: string) {
    super(`Unknown symbol: ${symbol}`);
    this.name = 'UnknownSymbolError';
  }
}

/** A real provider does network I/O and cannot answer synchronously; the synthetic engine still can. */
export type MaybePromise<T> = T | Promise<T>;

export interface MarketEngine {
  /**
   * Which timeframes this engine can actually serve. The synthetic engine serves all
   * six; a real provider may serve fewer, because intraday data is commonly a
   * higher-priced tier than end-of-day.
   *
   * The proxy answers `UNAUTHORIZED` for a timeframe outside this list — the contract
   * has always defined that code as covering a key that "lacks the plan tier for this
   * data". But an error is the fallback, not the design: `GET /api/capabilities`
   * publishes this list so the client can disable the timeframes it cannot fetch
   * rather than letting someone click one and receive a failure.
   */
  readonly supportedTimeframes: readonly Timeframe[];

  /**
   * True when this engine's data is delayed rather than live. Surfaced as
   * `Snapshot.delayed` and badged in the UI. The synthetic engine reads this from
   * `SYNTHETIC_DELAYED` so the badge is exercisable.
   */
  readonly delayed: boolean;

  /** Resolve a user-supplied ticker to its canonical form, or undefined if unknown. */
  resolveSymbol(symbol: string): MaybePromise<EngineSymbol | undefined>;

  /**
   * Relevance-ordered symbol search over ticker and name, case-insensitive.
   * An exact ticker match ranks first, then prefix matches, then substring matches.
   * No match is an empty array, never an error.
   */
  searchSymbols(query: string, limit: number): MaybePromise<SearchResult[]>;

  /** @throws UnknownSymbolError */
  getBars(req: EngineBarsRequest): MaybePromise<EngineBarsResult>;

  /** @throws UnknownSymbolError */
  getSnapshot(symbol: string, asOf: UnixSeconds): MaybePromise<Snapshot>;
}

// ───────────────────────────────────────────────────────────────────────────────
// INVARIANTS THE ENGINE MUST UPHOLD
//
// These are the acceptance criteria. Each one is a test.
//
// 1. DETERMINISM. `getBars` for the same (symbol, timeframe, from, to, adjusted) is
//    byte-identical across calls, across process restarts, and regardless of what
//    else was requested in between. The chart lazy-loads older history as the user
//    pans; if a re-request returns different prices, the chart visibly corrupts.
//    Derive everything from a hash of the symbol. No Math.random(), no Date.now()
//    inside price generation.
//
// 2. CROSS-TIMEFRAME COHERENCE — scoped to timeframe FAMILIES (revised in Phase 5).
//    Bars must agree when aggregated WITHIN a family:
//      • the INTRADAY family: 1m → 5m → 15m → 1h
//      • the DAILY family:    1D → 1W
//    For a bar and the bars it aggregates: open = first open, close = last close,
//    high = max high, low = min low, volume = summed volume. Exactly.
//
//    The boundary BETWEEN the families (1h → 1D) is NOT required to agree for a real
//    provider, and it does not. Measured on FMP: a session's 5-minute volumes sum to
//    66–75% of that day's 1D volume, and open/close differ by cents. That is correct
//    data, not a defect. The official daily bar includes the opening and closing
//    auctions and extended hours, and its close is the auction price. Intraday bars
//    cover continuous regular-session trading only. Every real vendor works this way.
//
//    The first version of this invariant demanded exact agreement across ALL
//    timeframes. Only a synthetic engine can do that. The SYNTHETIC engine still does,
//    because it builds every timeframe from one minute-level path, and its tests keep
//    asserting the full chain. Do not weaken the synthetic engine to match reality.
//
//    Consequence for the forming bar: never rebuild a DAILY-family bar from
//    intraday-family bars for a real provider. Today's 1D bar would show ~70% of its
//    real volume and then jump when the official bar arrives. Use the provider's own
//    daily bar.
//
// 3. MARKET CALENDAR. Bars exist only during US equity regular sessions:
//    09:30–16:00 America/New_York, Monday–Friday, excluding US market holidays, with
//    early 13:00 closes on the usual half-days (day after Thanksgiving, Christmas Eve
//    when it falls on a weekday, 3 July when observed).
//      • Use `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` to convert.
//        Do NOT hardcode a UTC offset: the offset is -5 or -4 depending on DST, and
//        hardcoding it puts every intraday bar an hour off for half the year.
//      • A `1D` bar's `time` is the session's 00:00 in New York, expressed in Unix
//        seconds. A `1W` bar's `time` is its Monday.
//      • Intraday bar `time` is the bar's OPEN, so the last 5m bar of a normal
//        session opens at 15:55 and there is no 16:00 bar.
//
// 4. NO INVENTED HISTORY. Nothing before `listedAt`. A range entirely before it is
//    an empty array with `truncated: false` — a valid, successful, empty answer.
//
// 5. PLAUSIBLE PRICES. Within every bar: `low <= min(open, close)` and
//    `high >= max(open, close)`, all strictly positive. `volume` is a non-negative
//    integer. Volume should show the real intraday U-shape — heavy at the open,
//    light midday, heavy into the close — because a flat volume profile is the
//    tell-tale of fake data.
//
// 6. SPLITS. At least two symbols carry a synthetic split in their history. With
//    `adjusted: true` (the default) prices before the split are divided by the ratio
//    and volumes multiplied, giving a continuous series. With `adjusted: false` the
//    raw series shows the discontinuity. Both must be deterministic.
//
// 7. ORDERING. Ascending by `time`, strictly increasing, no duplicates. Always.
// ───────────────────────────────────────────────────────────────────────────────
