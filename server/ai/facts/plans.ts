/**
 * Risk plans for the trade-check skill. The rules come from the skill
 * (server/ai/skills/trade-check.md, "Risk plans") and the backtest
 * (docs/ai-samples/BACKTEST_REPORT.md):
 *
 * - Stop = invalidation ± 0.5 × ATR of the lower timeframe, on the far side of the level.
 * - R:R uses the entry in the range that gives the lower R:R, and the same entry and stop
 *   for every target.
 * - A percent distance is (price − reference) / reference.
 * - Size is 1% account risk; 0.5% against the higher-timeframe trend or with earnings in
 *   10 sessions or less.
 */
export type Direction = 'long' | 'short';
export type PlanKind = 'market' | 'retest' | 'continuation';

export interface Level {
  price: number;
  label: string;
}

export interface PlanInput {
  kind: PlanKind;
  side: Direction;
  /** `limit`: fill at a level as price comes to it. `stop`: fill after a close through a level. */
  entryType: 'market' | 'limit' | 'stop';
  entryLow: number;
  entryHigh: number;
  trigger: string;
  invalidation: Level;
  /** ATR14 of the lower timeframe (4H for a 1D plan). */
  atrLower: number;
  /** Candidate targets in any order; the plan keeps up to 3 past the entry. */
  targets: readonly Level[];
  againstHigherTrend: boolean;
  /** Sessions to the next earnings report; null when unknown. */
  earningsSessions: number | null;
  /** A target nearer than this to the R:R entry is left out. Default 0. */
  minTargetDistance?: number;
}

export interface PlanTarget extends Level {
  /** From the R:R entry, signed. */
  pct: number;
  rr: number;
}

export interface Plan {
  kind: PlanKind;
  side: Direction;
  entryType: PlanInput['entryType'];
  entryLow: number;
  entryHigh: number;
  /** The entry that the R:R uses. */
  rrEntry: number;
  trigger: string;
  invalidation: Level;
  stop: number;
  stopPct: number;
  /** stop = invalidation ∓ atrMult × atrLower. */
  stopRule: { invalidation: number; atrMult: number; atrLower: number };
  targets: PlanTarget[];
  sizePct: 0.5 | 1;
  sizeReason: string | null;
  /** The R:R to the last target is 2:1 or more. */
  meetsTwoToOne: boolean;
}

export const STOP_ATR_MULT = 0.5;
export const EARNINGS_SIZE_SESSIONS = 10;
/** Targets are at least this many daily ATRs from the entry. */
export const MIN_TARGET_ATR = 0.5;

export const pctFrom = (price: number, reference: number): number => ((price - reference) / reference) * 100;

/** Null when the stop is not past the entry or no target is past the entry. */
export function buildPlan(input: PlanInput): Plan | null {
  const sign = input.side === 'long' ? 1 : -1;
  const stop = input.invalidation.price - sign * STOP_ATR_MULT * input.atrLower;
  // Long: the higher entry risks more and earns less. Short: the lower entry.
  const rrEntry = input.side === 'long' ? input.entryHigh : input.entryLow;
  const risk = sign * (rrEntry - stop);
  if (!(risk > 0)) return null;
  const seen = new Set<number>();
  const targets = [...input.targets]
    .filter((t) => sign * (t.price - rrEntry) > Math.max(0, input.minTargetDistance ?? 0))
    .sort((a, b) => sign * (a.price - b.price))
    .filter((t) => (seen.has(t.price) ? false : (seen.add(t.price), true)))
    .slice(0, 3)
    .map((t) => ({ ...t, pct: pctFrom(t.price, rrEntry), rr: (sign * (t.price - rrEntry)) / risk }));
  if (targets.length === 0) return null;

  const reasons: string[] = [];
  if (input.againstHigherTrend) reasons.push('against the higher-timeframe trend');
  if (input.earningsSessions !== null && input.earningsSessions <= EARNINGS_SIZE_SESSIONS) {
    reasons.push(`earnings in ${input.earningsSessions} sessions`);
  }
  return {
    kind: input.kind,
    side: input.side,
    entryType: input.entryType,
    entryLow: input.entryLow,
    entryHigh: input.entryHigh,
    rrEntry,
    trigger: input.trigger,
    invalidation: input.invalidation,
    stop,
    stopPct: pctFrom(stop, rrEntry),
    stopRule: { invalidation: input.invalidation.price, atrMult: STOP_ATR_MULT, atrLower: input.atrLower },
    targets,
    sizePct: reasons.length ? 0.5 : 1,
    sizeReason: reasons.length ? reasons.join('; ') : null,
    meetsTwoToOne: (targets[targets.length - 1] as PlanTarget).rr >= 2,
  };
}

export interface PlanContext {
  price: number;
  atrDaily: number;
  atrLower: number;
  /** Levels above and below price, from swings, zones, and structure. */
  levels: readonly Level[];
  /** The newest break level for each side, with its label. */
  lastBearishBreak: Level | null;
  lastBullishBreak: Level | null;
  againstTrend: Record<Direction, boolean>;
  earningsSessions: number | null;
}

/**
 * Levels nearer than `minGap` to each other become one (the first one stays). Sorted from
 * low to high.
 */
export function mergeLevels(levels: readonly Level[], minGap: number): Level[] {
  const sorted = [...levels].filter((l) => Number.isFinite(l.price) && l.price > 0).sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev && l.price - prev.price < minGap) continue;
    out.push(l);
  }
  return out;
}

/** The at-market, retest, and continuation plans for one side. Plans that cannot exist are left out. */
export function plansFor(side: Direction, ctx: PlanContext): Plan[] {
  const sign = side === 'long' ? 1 : -1;
  const levels = mergeLevels(ctx.levels, 0.1 * ctx.atrDaily);
  // Nearest first, in the trade direction (ahead) or against it (behind).
  const ahead = (from: number) => levels.filter((l) => sign * (l.price - from) > 0).sort((a, b) => sign * (a.price - b.price));
  const behind = (from: number) => levels.filter((l) => sign * (l.price - from) < 0).sort((a, b) => sign * (b.price - a.price));
  // A target nearer than half a day's range is not worth the risk (the live TER answer had T1 0.47% away).
  const common = {
    side, atrLower: ctx.atrLower, againstHigherTrend: ctx.againstTrend[side], earningsSessions: ctx.earningsSessions,
    minTargetDistance: MIN_TARGET_ATR * ctx.atrDaily,
  };
  const out: Plan[] = [];

  // At market: invalidation at the nearest level behind price.
  const guard = behind(ctx.price)[0];
  if (guard) {
    const p = buildPlan({
      ...common, kind: 'market', entryType: 'market', entryLow: ctx.price, entryHigh: ctx.price,
      trigger: 'enter at the current price', invalidation: guard, targets: ahead(ctx.price),
    });
    if (p) out.push(p);
  }

  // Retest: back to the level that the last break in the trade direction passed.
  const broken = side === 'short' ? ctx.lastBearishBreak : ctx.lastBullishBreak;
  if (broken && sign * (broken.price - ctx.price) < 0 && Math.abs(broken.price - ctx.price) <= 3 * ctx.atrDaily) {
    const near = broken.price + sign * 0.1 * ctx.atrDaily;
    const p = buildPlan({
      ...common, kind: 'retest', entryType: 'limit',
      entryLow: Math.min(near, broken.price), entryHigh: Math.max(near, broken.price),
      trigger: `${side === 'short' ? 'sell' : 'buy'} limit after price comes back to ${broken.label} and a 4H candle rejects it`,
      invalidation: { price: broken.price, label: `close back ${side === 'short' ? 'above' : 'below'} ${broken.label}` },
      targets: ahead(ctx.price),
    });
    if (p) out.push(p);
  }

  // Continuation: a daily close through the nearest level ahead.
  const next = ahead(ctx.price)[0];
  if (next) {
    const entry = next.price + sign * 0.1 * ctx.atrDaily;
    const p = buildPlan({
      ...common, kind: 'continuation', entryType: 'stop', entryLow: entry, entryHigh: entry,
      trigger: `${side === 'short' ? 'sell' : 'buy'} stop after a daily close ${side === 'short' ? 'below' : 'above'} ${next.label}`,
      invalidation: { price: next.price, label: `close back ${side === 'short' ? 'above' : 'below'} ${next.label}` },
      targets: ahead(entry),
    });
    if (p) out.push(p);
  }
  return out;
}
