/**
 * The alert checker (docs/ALERTS_PLAN.md, sections 5.1 and 6).
 *
 * The symbols with active alerts form a queue. Each `tick` checks the symbols that are due,
 * the longest-waiting first, while the call budget allows:
 *  - Price alerts of a symbol share one quote, at most each ALERT_MIN_CHECK_SECONDS.
 *  - Indicator alerts of one symbol and one timeframe share one bars call, after a bar close.
 *  - `budgetPerMinute` caps the upstream calls in any 60 s window. Null means no cap
 *    (the synthetic provider). A quote served from the shared cache costs no call.
 *
 * One checker per server, so two open tabs never fire one alert twice.
 * The clock is injected; tests drive `tick()` directly.
 */
import type { Alert, Bar, Snapshot, Timeframe, UnixSeconds } from '@shared/types';
import { ALERT_MIN_CHECK_SECONDS } from '@shared/types';
import { evaluateIndicatorAlert, evaluatePriceAlert, TIMEFRAME_SPAN_SECONDS } from './evaluate';
import type { AlertsStore, AppliedCheck } from './store';

/** Default share of the provider budget for alerts (D2). The watchlist keeps the rest. */
export const ALERT_CALL_BUDGET = 150;
/** After a bars call with no new closed bar (a weekend, a holiday), wait at least this long. */
export const BARS_RETRY_SECONDS = 3_600;

/** Where the checker reads market data. */
export interface AlertDataSource {
  /** A quote. `cached` is true when no upstream call was made. */
  quote(symbol: string): Promise<{ snapshot: Snapshot; cached: boolean }>;
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
}

/** Bars to load for an indicator: its longest period plus a margin for EMA warmup. */
function barsNeeded(alert: Alert): number {
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

export class AlertScheduler {
  /** Times of the upstream calls in the last 60 s. */
  private calls: UnixSeconds[] = [];
  private lastQuoteAt = new Map<string, UnixSeconds>();
  /** Key `symbol|timeframe`. */
  private lastBarsAt = new Map<string, UnixSeconds>();
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
    const last = this.lastBarsAt.get(`${symbol}|${timeframe}`) ?? -Infinity;
    if (now - last < ALERT_MIN_CHECK_SECONDS) return false;
    if (alerts.some((a) => a.state.lastBarTime === null)) return true;
    const span = TIMEFRAME_SPAN_SECONDS[timeframe];
    const oldest = Math.min(...alerts.map((a) => a.state.lastBarTime as number));
    // The bar after `oldest` closes at `oldest + 2 * span` at the earliest.
    return now >= oldest + 2 * span && now - last >= Math.min(span, BARS_RETRY_SECONDS);
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
      // All checks of one tick go to the store in one write.
      const checks: AppliedCheck[] = [];
      for (const symbol of queue) {
        if (!this.canCall(now)) break;
        checks.push(...(await this.checkSymbol(symbol, bySymbol.get(symbol) as Alert[], now)));
      }
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

  private async checkSymbol(symbol: string, alerts: Alert[], now: UnixSeconds): Promise<AppliedCheck[]> {
    const checks: AppliedCheck[] = [];
    let visited = false;

    // Expired alerts need no data.
    const live: Alert[] = [];
    for (const a of alerts) {
      if (now >= a.expiresAt) {
        const result = a.condition.type === 'price' ? evaluatePriceAlert(a, { price: null, dayHigh: null, dayLow: null }, now) : evaluateIndicatorAlert(a, [], now);
        checks.push({ alertId: a.id, revision: a.revision, result, delayed: false });
      } else live.push(a);
    }

    const price = live.filter((a) => a.condition.type === 'price');
    if (price.length > 0 && this.priceDue(symbol, now) && this.canCall(now)) {
      visited = true;
      try {
        const { snapshot, cached } = await this.deps.source.quote(symbol);
        if (!cached) this.spend(now);
        this.lastQuoteAt.set(symbol, now);
        const obs = { price: snapshot.price, dayHigh: snapshot.dayHigh, dayLow: snapshot.dayLow };
        for (const a of price) checks.push({ alertId: a.id, revision: a.revision, result: evaluatePriceAlert(a, obs, now), delayed: snapshot.delayed });
      } catch (err) {
        this.spend(now);
        this.lastQuoteAt.set(symbol, now);
        this.warnOnce(`quote:${symbol}`, `Alert check: no quote for ${symbol}: ${(err as Error).message}`);
      }
    }

    const byTimeframe = new Map<Timeframe, Alert[]>();
    for (const a of live) {
      if (a.condition.type !== 'indicator') continue;
      const list = byTimeframe.get(a.condition.timeframe) ?? [];
      list.push(a);
      byTimeframe.set(a.condition.timeframe, list);
    }
    for (const [timeframe, group] of byTimeframe) {
      if (!this.barsDue(symbol, timeframe, group, now) || !this.canCall(now)) continue;
      visited = true;
      this.spend(now);
      this.lastBarsAt.set(`${symbol}|${timeframe}`, now);
      try {
        const n = Math.max(...group.map(barsNeeded));
        const bars = await this.deps.source.bars(symbol, timeframe, now - lookbackSeconds(timeframe, n), now);
        for (const a of group) {
          checks.push({ alertId: a.id, revision: a.revision, result: evaluateIndicatorAlert(a, bars, now), delayed: this.deps.source.delayed });
        }
      } catch (err) {
        this.warnOnce(`bars:${symbol}|${timeframe}`, `Alert check: no bars for ${symbol} ${timeframe}: ${(err as Error).message}`);
      }
    }

    if (visited) this.lastVisit.set(symbol, now);
    return checks;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    (this.deps.warn ?? ((m: string) => console.warn(m)))(message);
  }
}
