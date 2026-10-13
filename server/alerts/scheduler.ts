/**
 * The alert checker (docs/ALERTS_PLAN.md, sections 5.1 and 6).
 *
 * The symbols with active alerts form a queue. Each `tick` checks the symbols that are due,
 * the longest-waiting first, while the call budget allows:
 *  - Price alerts of a symbol share one quote, at most each ALERT_MIN_CHECK_SECONDS.
 *  - Indicator and confluence alerts of one symbol and one timeframe share one bars call,
 *    after a bar close.
 *  - `budgetPerMinute` caps the upstream calls in any 60 s window. Null means no cap
 *    (the synthetic provider). A quote served from the shared cache costs no call.
 *
 * When the budget runs out while checks are due, the checker tells the user (a `budget`
 * stream message), at most ALERT_BUDGET_WARNINGS times per server run.
 *
 * One checker per server, so two open tabs never fire one alert twice.
 * The clock is injected; tests drive `tick()` directly.
 */
import type { Alert, AlertStreamMessage, Bar, Snapshot, Timeframe, UnixSeconds } from '@shared/types';
import { ALERT_BUDGET_WARNINGS, ALERT_MIN_CHECK_SECONDS } from '@shared/types';
import { closedBars, evaluateAlert, evaluatePriceAlert, TIMEFRAME_SPAN_SECONDS } from './evaluate';
import type { AlertsStore, AppliedCheck } from './store';

/** Default share of the provider budget for alerts (D2). The watchlist keeps the rest. */
export const ALERT_CALL_BUDGET = 150;
/**
 * After bars calls with no new closed bar (a night, a weekend, a holiday), the wait doubles
 * from one bar span (or this limit, when it is shorter) up to this limit. A new bar sets it back.
 */
export const BARS_RETRY_SECONDS = 3_600;
/** A budget shortage that follows a full minute with no shortage counts as a new one. */
const BUDGET_EPISODE_GAP_SECONDS = 60;

/** Where the checker reads market data. */
export interface AlertDataSource {
  /** A quote. `cached` is true when no upstream call was made. */
  quote(symbol: string): Promise<{ snapshot: Snapshot; cached: boolean }>;
  /** A fresh quote that is already in the cache, or undefined. Never calls upstream. */
  cachedQuote?(symbol: string): Snapshot | undefined;
  /** Bars, ascending. Each call counts against the budget. */
  bars(symbol: string, timeframe: Timeframe, from: UnixSeconds, to: UnixSeconds): Promise<Bar[]>;
  /** The bars are delayed (the provider tier). */
  readonly delayed: boolean;
}

export interface AlertSchedulerDeps {
  store: AlertsStore;
  source: AlertDataSource;
  now: () => UnixSeconds;
  /** Upstream calls in any 60 s window. Null: no cap. */
  budgetPerMinute: number | null;
  warn?: (message: string) => void;
  /** Sends a stream message to the open tabs (the budget warning). */
  notify?: (message: AlertStreamMessage) => void;
}

/**
 * Bars to load for an indicator: its longest period plus a margin for EMA warmup. A confluence
 * alert needs only the volume average: its level is frozen in the alert.
 */
function barsNeeded(alert: Alert): number {
  if (alert.condition.type === 'confluence') return Math.max(300, alert.condition.params.volumeLength + 50);
  if (alert.condition.type !== 'indicator') return 0;
  const numbers = Object.values(alert.condition.indicator.params).filter((v): v is number => typeof v === 'number');
  const sum = numbers.reduce((a, b) => a + b, 0);
  return Math.max(300, 3 * sum + 50);
}

/** Calendar seconds that hold `n` bars: intraday bars exist only in sessions; daily bars skip weekends. */
function lookbackSeconds(timeframe: Timeframe, n: number): number {
  const span = TIMEFRAME_SPAN_SECONDS[timeframe];
  const factor = timeframe === '1W' ? 1.1 : timeframe === '1D' ? 1.6 : 6;
  return Math.ceil(n * span * factor) + 7 * 86_400;
}

/**
 * The first check of a confluence alert replays the bars from its lock bar, plus the bars of
 * the volume average before it. Later checks, and other alerts, need nothing older (Infinity).
 * A range longer than the provider's cap gives the newest bars; the replay then starts at the first.
 */
function replayFrom(alert: Alert, timeframe: Timeframe): UnixSeconds {
  const c = alert.condition;
  if (c.type !== 'confluence' || alert.state.lastBarTime !== null) return Infinity;
  return c.lock.time - lookbackSeconds(timeframe, c.params.volumeLength);
}

export class AlertScheduler {
  /** Times of the upstream calls in the last 60 s. */
  private calls: UnixSeconds[] = [];
  private lastQuoteAt = new Map<string, UnixSeconds>();
  /** Key `symbol|timeframe`. */
  private lastBarsAt = new Map<string, UnixSeconds>();
  /** Key `symbol|timeframe`: bars calls in a row that found no new closed bar. */
  private barsMisses = new Map<string, number>();
  /** The last tick that left due checks for lack of budget; null before the first. */
  private lastShortAt: UnixSeconds | null = null;
  private budgetWarnings = 0;
  /** When each symbol was last visited, for the round robin. */
  private lastVisit = new Map<string, UnixSeconds>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<string>();

  constructor(private readonly deps: AlertSchedulerDeps) {}

  /** Calls `tick` each `ms` until `stop`. */
  start(ms = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The expected time between two price checks of one symbol, for the Alerts window. */
  checkIntervalSeconds(): number {
    const budget = this.deps.budgetPerMinute;
    const symbols = new Set(this.active().map((a) => a.symbol)).size;
    if (budget === null || symbols === 0) return ALERT_MIN_CHECK_SECONDS;
    return Math.max(ALERT_MIN_CHECK_SECONDS, Math.ceil((symbols / budget) * 60));
  }

  /** The upstream calls in the 60 s before `now` (tests read it). */
  callsInLastMinute(): number {
    this.prune(this.deps.now());
    return this.calls.length;
  }

  private active(): Alert[] {
    return this.deps.store.list().filter((a) => a.status === 'active');
  }

  private prune(now: UnixSeconds): void {
    this.calls = this.calls.filter((t) => t > now - 60);
  }

  private canCall(now: UnixSeconds, n = 1): boolean {
    const budget = this.deps.budgetPerMinute;
    if (budget === null) return true;
    this.prune(now);
    return this.calls.length + n <= budget;
  }

  private spend(now: UnixSeconds): void {
    if (this.deps.budgetPerMinute !== null) this.calls.push(now);
  }

  private priceDue(symbol: string, now: UnixSeconds): boolean {
    return now - (this.lastQuoteAt.get(symbol) ?? -Infinity) >= ALERT_MIN_CHECK_SECONDS;
  }

  private barsDue(symbol: string, timeframe: Timeframe, alerts: Alert[], now: UnixSeconds): boolean {
    const key = `${symbol}|${timeframe}`;
    const last = this.lastBarsAt.get(key) ?? -Infinity;
    if (now - last < ALERT_MIN_CHECK_SECONDS) return false;
    if (alerts.some((a) => a.state.lastBarTime === null)) return true;
    const span = TIMEFRAME_SPAN_SECONDS[timeframe];
    const oldest = Math.min(...alerts.map((a) => a.state.lastBarTime as number));
    // The bar after `oldest` closes at `oldest + 2 * span` at the earliest. When the market
    // is closed no bar comes, so each empty call doubles the wait (up to BARS_RETRY_SECONDS).
    const misses = this.barsMisses.get(key) ?? 0;
    const wait = Math.min(Math.min(span, BARS_RETRY_SECONDS) * 2 ** misses, BARS_RETRY_SECONDS);
    return now >= oldest + 2 * span && now - last >= wait;
  }

  /** Tells the user when the budget ran out with checks due: once per shortage, at most ALERT_BUDGET_WARNINGS times. */
  private budgetShort(waitingSymbols: number, now: UnixSeconds): void {
    const budget = this.deps.budgetPerMinute;
    const isNew = this.lastShortAt === null || now - this.lastShortAt > BUDGET_EPISODE_GAP_SECONDS;
    this.lastShortAt = now;
    if (!isNew || budget === null || this.budgetWarnings >= ALERT_BUDGET_WARNINGS) return;
    this.budgetWarnings += 1;
    (this.deps.warn ?? ((m: string) => console.warn(m)))(
      `Alert check: all ${budget} calls of this minute are used; ${waitingSymbols} symbols wait (warning ${this.budgetWarnings} of ${ALERT_BUDGET_WARNINGS}).`,
    );
    this.deps.notify?.({ type: 'budget', budgetPerMinute: budget, waitingSymbols });
  }

  /** Check the due symbols while the budget allows. Never runs twice at once. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      const bySymbol = new Map<string, Alert[]>();
      for (const a of this.active()) {
        const list = bySymbol.get(a.symbol) ?? [];
        list.push(a);
        bySymbol.set(a.symbol, list);
      }
      for (const key of [...this.lastVisit.keys()]) if (!bySymbol.has(key)) this.lastVisit.delete(key);
      const queue = [...bySymbol.keys()].sort((x, y) => (this.lastVisit.get(x) ?? -Infinity) - (this.lastVisit.get(y) ?? -Infinity));
      // All checks of one tick go to the store in one write. A symbol is visited also when
      // the budget is used up: expiries and cached quotes cost no call.
      const checks: AppliedCheck[] = [];
      let waitingSymbols = 0;
      for (const symbol of queue) {
        const visit = await this.checkSymbol(symbol, bySymbol.get(symbol) as Alert[], now);
        checks.push(...visit.checks);
        if (visit.waiting) waitingSymbols += 1;
      }
      if (waitingSymbols > 0) this.budgetShort(waitingSymbols, now);
      if (checks.length > 0) {
        try {
          await this.deps.store.applyChecks(checks);
        } catch (err) {
          this.warnOnce('store', `Alert check: could not save: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** `waiting`: a check of this symbol was due, but the budget had no call left for it. */
  private async checkSymbol(symbol: string, alerts: Alert[], now: UnixSeconds): Promise<{ checks: AppliedCheck[]; waiting: boolean }> {
    const checks: AppliedCheck[] = [];
    let visited = false;
    let waiting = false;

    // Expired alerts need no data.
    const live: Alert[] = [];
    for (const a of alerts) {
      if (now >= a.expiresAt) {
        const result = evaluateAlert(a, {}, now);
        checks.push({ alertId: a.id, revision: a.revision, result, delayed: false });
      } else live.push(a);
    }

    const price = live.filter((a) => a.condition.type === 'price');
    if (price.length > 0 && this.priceDue(symbol, now)) {
      const checkPrice = (snapshot: Snapshot) => {
        this.lastQuoteAt.set(symbol, now);
        const obs = { price: snapshot.price, dayHigh: snapshot.dayHigh, dayLow: snapshot.dayLow };
        for (const a of price) checks.push({ alertId: a.id, revision: a.revision, result: evaluatePriceAlert(a, obs, now), delayed: snapshot.delayed });
      };
      const hit = this.deps.source.cachedQuote?.(symbol);
      if (hit) {
        visited = true;
        checkPrice(hit);
      } else if (this.canCall(now)) {
        visited = true;
        try {
          const { snapshot, cached } = await this.deps.source.quote(symbol);
          if (!cached) this.spend(now);
          checkPrice(snapshot);
        } catch (err) {
          this.spend(now);
          this.lastQuoteAt.set(symbol, now);
          this.warnOnce(`quote:${symbol}`, `Alert check: no quote for ${symbol}: ${(err as Error).message}`);
        }
      } else waiting = true;
    }

    const byTimeframe = new Map<Timeframe, Alert[]>();
    for (const a of live) {
      if (a.condition.type === 'price') continue;
      const list = byTimeframe.get(a.condition.timeframe) ?? [];
      list.push(a);
      byTimeframe.set(a.condition.timeframe, list);
    }
    for (const [timeframe, group] of byTimeframe) {
      if (!this.barsDue(symbol, timeframe, group, now)) continue;
      if (!this.canCall(now)) {
        waiting = true;
        continue;
      }
      visited = true;
      this.spend(now);
      const key = `${symbol}|${timeframe}`;
      this.lastBarsAt.set(key, now);
      try {
        const n = Math.max(...group.map(barsNeeded));
        const bars = await this.deps.source.bars(symbol, timeframe, Math.min(now - lookbackSeconds(timeframe, n), ...group.map((a) => replayFrom(a, timeframe))), now);
        const newest = closedBars(bars, timeframe, now).at(-1)?.time;
        const known = group.map((a) => a.state.lastBarTime);
        const gotNewBar = newest !== undefined && known.some((t) => t === null || newest > t);
        this.barsMisses.set(key, gotNewBar ? 0 : (this.barsMisses.get(key) ?? 0) + 1);
        for (const a of group) {
          checks.push({ alertId: a.id, revision: a.revision, result: evaluateAlert(a, { bars }, now), delayed: this.deps.source.delayed });
        }
      } catch (err) {
        this.warnOnce(`bars:${symbol}|${timeframe}`, `Alert check: no bars for ${symbol} ${timeframe}: ${(err as Error).message}`);
      }
    }

    if (visited) this.lastVisit.set(symbol, now);
    return { checks, waiting };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    (this.deps.warn ?? ((m: string) => console.warn(m)))(message);
  }
}
