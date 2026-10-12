/**
 * Confluence trigger levels: the user's Turn Confirmation Levels (mode "turn") and
 * Breakdown Confluence Levels (mode "breakdown") Pine scripts in one pure function.
 *
 * The specification is docs/CONFLUENCE_PLAN.md, section 4. Where it differs from the
 * scripts (plan section 2), the plan wins:
 *  - A breakout compares the close with the PREVIOUS bar's trigger. The Turn script
 *    compares it with the same bar's trigger, which sits above that close by
 *    construction, so its breakout never fires.
 *  - Mode "turn" has the mirror of the Breakdown script's latch.
 *
 * One pass over the bars. Per bar: collect up to 13 fixed levels plus the retained pivots,
 * keep the side of the mode, sort, cluster, rank. O(n × c log c), c <= 113.
 */
import type { Bar, ConfluenceMode, ConfluenceParams } from '@shared/types';
import { ema, sma } from './math';
import { assertValidParams } from './params';
import { isPivotHigh, isPivotLow } from './pivots';
import { CONFLUENCE_MAX_PIVOTS } from './types';

export interface ConfluenceCluster {
  bottom: number;
  top: number;
  /** How many candidate levels the band holds. */
  count: number;
}

export interface ConfluenceEvent {
  index: number;
  time: number;
  /** The level the close went through: the previous bar's trigger, or the locked top. */
  level: number;
  /** The confluence count of that level's cluster. */
  count: number;
  /** True when the event came from a locked level (plan §4.9). */
  latched: boolean;
}

export interface ConfluenceSource {
  kind: 'fib' | 'ma';
  /** Stable name, for example "Fib 0.618" or "SMA 200". */
  name: string;
  value: number;
}

export interface ConfluencePoint {
  index: number;
  price: number;
}

/** The state at the last bar (plan §4.10). */
export interface ConfluenceState {
  index: number;
  /** The locked clusters while the latch holds, otherwise the live ones. */
  primary: ConfluenceCluster | null;
  secondary: ConfluenceCluster | null;
  /** `primary.top`, or null. */
  trigger: number | null;
  latched: boolean;
  /** Turn: the latest pivot low of any age. Breakdown: the latest retained pivot high. */
  invalidation: ConfluencePoint | null;
  /** The defined Fibonacci and moving-average levels. */
  sources: ConfluenceSource[];
  /** Mode "breakdown": the level and bar of the latest breakdown (plan §4.8). */
  broken: ConfluencePoint | null;
}

export interface ConfluenceResult {
  mode: ConfluenceMode;
  events: ConfluenceEvent[];
  /** Null when there are no bars. */
  last: ConfluenceState | null;
  latch: {
    /** The first bar with `time >= latchTime` while the latch is on and has a date, else null. */
    index: number | null;
    /** Whether the latch holds at the last bar. */
    holds: boolean;
  };
}

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
const FIB_NAMES = ['Fib 0.236', 'Fib 0.382', 'Fib 0.500', 'Fib 0.618', 'Fib 0.786'] as const;
const MA_NAMES = ['EMA 10', 'EMA 20', 'EMA 50', 'SMA 50', 'SMA 100', 'SMA 200'] as const;

/** Highest high and lowest low of the last `n` bars, NaN until `n` bars exist. Monotonic deques, O(bars). */
function rollingExtremes(bars: readonly Bar[], n: number): { hi: Float64Array; lo: Float64Array } {
  const len = bars.length;
  const hi = new Float64Array(len).fill(NaN);
  const lo = new Float64Array(len).fill(NaN);
  const maxQ: number[] = [];
  const minQ: number[] = [];
  let maxHead = 0;
  let minHead = 0;
  for (let i = 0; i < len; i++) {
    const b = bars[i] as Bar;
    while (maxQ.length > maxHead && (bars[maxQ[maxQ.length - 1] as number] as Bar).high <= b.high) maxQ.pop();
    maxQ.push(i);
    while (minQ.length > minHead && (bars[minQ[minQ.length - 1] as number] as Bar).low >= b.low) minQ.pop();
    minQ.push(i);
    if ((maxQ[maxHead] as number) <= i - n) maxHead++;
    if ((minQ[minHead] as number) <= i - n) minHead++;
    if (i >= n - 1) {
      hi[i] = (bars[maxQ[maxHead] as number] as Bar).high;
      lo[i] = (bars[minQ[minHead] as number] as Bar).low;
    }
  }
  return { hi, lo };
}

/** Clusters of ascending `sorted` (plan §4.4). `maxWidth` is Infinity for no limit. */
export function buildClusters(sorted: ArrayLike<number>, tol: number, maxWidth: number): ConfluenceCluster[] {
  const out: ConfluenceCluster[] = [];
  let cur: ConfluenceCluster | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i] as number;
    if (cur !== null && v - cur.top <= tol && v - cur.bottom <= maxWidth) {
      cur.top = v;
      cur.count += 1;
    } else {
      if (cur !== null) out.push(cur);
      cur = { bottom: v, top: v, count: 1 };
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * The primary and secondary of the eligible clusters (plan §4.5). A higher count ranks first;
 * on a tie the band nearer the price wins: the lower top above, the higher top below.
 */
export function rankClusters(
  clusters: readonly ConfluenceCluster[],
  close: number,
  mode: ConfluenceMode,
  minCount: number,
  minDistancePct: number,
): { primary: ConfluenceCluster | null; secondary: ConfluenceCluster | null } {
  const turn = mode === 'turn';
  const d = minDistancePct / 100;
  const better = (a: ConfluenceCluster, b: ConfluenceCluster | null): boolean =>
    b === null || a.count > b.count || (a.count === b.count && (turn ? a.top < b.top : a.top > b.top));
  let primary: ConfluenceCluster | null = null;
  let secondary: ConfluenceCluster | null = null;
  for (const c of clusters) {
    const far = turn ? c.bottom >= close * (1 + d) : c.top <= close * (1 - d);
    if (!far || c.count < minCount) continue;
    if (better(c, primary)) {
      secondary = primary;
      primary = c;
    } else if (better(c, secondary)) {
      secondary = c;
    }
  }
  return { primary, secondary };
}

/** Clusters, triggers, events and the latch for `bars` (ascending by time). Throws on invalid params. */
export function computeConfluence(bars: readonly Bar[], params: ConfluenceParams): ConfluenceResult {
  assertValidParams('confluence', params);
  const p = params;
  const turn = p.mode === 'turn';
  const n = bars.length;
  const minCount = turn ? p.turnMinConfluence : p.breakdownMinConfluence;
  const minDistancePct = turn ? p.turnMinDistancePct : p.breakdownMinDistancePct;

  const closes = new Float64Array(n);
  const volumes = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    closes[i] = (bars[i] as Bar).close;
    volumes[i] = (bars[i] as Bar).volume;
  }
  const mas = [ema(closes, 10), ema(closes, 20), ema(closes, 50), sma(closes, 50), sma(closes, 100), sma(closes, 200)];
  const volAvg = sma(volumes, p.volumeLength);
  const { hi, lo } = rollingExtremes(bars, p.swingLookback);

  const pivotHighs: ConfluencePoint[] = [];
  const pivotLows: ConfluencePoint[] = [];
  let latestPivotLow: ConfluencePoint | null = null;

  const buffer = new Float64Array(13 + 2 * CONFLUENCE_MAX_PIVOTS);
  const events: ConfluenceEvent[] = [];
  let prevTrigger: number | null = null;
  let prevCount = 0;
  let lock: { primary: ConfluenceCluster; secondary: ConfluenceCluster | null } | null = null;
  let fired = false;
  let broken: ConfluencePoint | null = null;
  let latchIndex: number | null = null;
  let holds = false;
  let livePrimary: ConfluenceCluster | null = null;
  let liveSecondary: ConfluenceCluster | null = null;

  const latchOn = p.latch === 'on' && p.latchTime > 0;

  for (let t = 0; t < n; t++) {
    const bar = bars[t] as Bar;
    const close = bar.close;

    // Pivots confirmed on this bar (§4.2), then age and count pruning.
    const i = t - p.pivotRight;
    if (i >= p.pivotLeft) {
      if (isPivotHigh(bars, i, p.pivotLeft, p.pivotRight)) pivotHighs.push({ index: i, price: (bars[i] as Bar).high });
      if (isPivotLow(bars, i, p.pivotLeft, p.pivotRight)) {
        latestPivotLow = { index: i, price: (bars[i] as Bar).low };
        pivotLows.push(latestPivotLow);
      }
    }
    for (const list of [pivotHighs, pivotLows]) {
      while (list.length > 0 && t - (list[0] as ConfluencePoint).index > p.pivotMaxAge) list.shift();
      while (list.length > CONFLUENCE_MAX_PIVOTS) list.shift();
    }

    // Candidates on the mode's side of the close (§4.1, §4.3).
    let k = 0;
    const add = (v: number) => {
      if (Number.isNaN(v)) return;
      if (turn ? v > close : v < close) buffer[k++] = v;
    };
    const H = hi[t] as number;
    const L = lo[t] as number;
    if (!Number.isNaN(H)) for (const r of FIB_RATIOS) add(L + (H - L) * r);
    for (const ma of mas) add(ma[t] as number);
    add(H);
    add(L);
    for (const pv of pivotHighs) add(pv.price);
    for (const pv of pivotLows) add(pv.price);
    const sorted = buffer.subarray(0, k).sort();

    // Clusters and ranking (§4.4, §4.5).
    const tol = (close * p.tolerancePct) / 100;
    const maxWidth = p.bandWidthMult > 0 ? tol * p.bandWidthMult : Infinity;
    ({ primary: livePrimary, secondary: liveSecondary } = rankClusters(
      buildClusters(sorted, tol, maxWidth),
      close,
      p.mode,
      minCount,
      minDistancePct,
    ));

    // Latch (§4.9).
    const active = latchOn && bar.time >= p.latchTime;
    if (active && latchIndex === null) latchIndex = t;
    if (!active) {
      lock = null;
      fired = false;
    } else if (lock === null && livePrimary !== null) {
      lock = { primary: livePrimary, secondary: liveSecondary };
    }
    holds = active && lock !== null;

    // Events (§4.6, §4.9).
    const avg = volAvg[t] as number;
    const volumeOk = !Number.isNaN(avg) && bar.volume >= avg * p.volumeMult;
    const range = bar.high - bar.low;
    const closeOk = turn || range <= 0 || (close - bar.low) / range <= p.closeQuality;
    let ref: number | null;
    let refCount: number;
    if (holds && lock !== null) {
      ref = lock.primary.top;
      refCount = lock.primary.count;
      // Re-arm before the test: a close back on the near side allows one more event.
      if (turn ? close < ref : close > ref) fired = false;
    } else {
      ref = prevTrigger;
      refCount = prevCount;
    }
    const through = ref !== null && (turn ? close > ref : close < ref);
    if (through && ref !== null && volumeOk && closeOk && !(holds && fired)) {
      events.push({ index: t, time: bar.time, level: ref, count: refCount, latched: holds });
      if (holds) fired = true;
      if (!turn) broken = { index: t, price: ref };
    }

    // The lagged reference always follows the live trigger, so turning the latch off resumes correctly.
    prevTrigger = livePrimary?.top ?? null;
    prevCount = livePrimary?.count ?? 0;
  }

  if (n === 0) return { mode: p.mode, events, last: null, latch: { index: null, holds: false } };

  const t = n - 1;
  const sources: ConfluenceSource[] = [];
  const H = hi[t] as number;
  const L = lo[t] as number;
  if (!Number.isNaN(H) && H > L) {
    FIB_RATIOS.forEach((r, j) => sources.push({ kind: 'fib', name: FIB_NAMES[j] as string, value: L + (H - L) * r }));
  }
  mas.forEach((ma, j) => {
    const v = ma[t] as number;
    if (!Number.isNaN(v)) sources.push({ kind: 'ma', name: MA_NAMES[j] as string, value: v });
  });
  const primary = holds && lock !== null ? lock.primary : livePrimary;
  const secondary = holds && lock !== null ? lock.secondary : liveSecondary;
  return {
    mode: p.mode,
    events,
    last: {
      index: t,
      primary,
      secondary,
      trigger: primary?.top ?? null,
      latched: holds,
      invalidation: turn ? latestPivotLow : (pivotHighs[pivotHighs.length - 1] ?? null),
      sources,
      broken,
    },
    latch: { index: latchIndex, holds },
  };
}
