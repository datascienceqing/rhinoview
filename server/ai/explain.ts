/**
 * The explanation of a fired AI alert (docs/AI_HELPER_PLAN.md, step E; the skill
 * `server/ai/skills/alert-explain.md`). Pure: the route loads the event, the saved analysis,
 * and the new facts.
 *
 * The server decides the trigger kind and the status from the bars after the fire. The model
 * only explains them (docs/ai-samples/006-alert-messages.md, lesson 2).
 */
import type { AlertEvent, AlertOrigin, Bar } from '@shared/types';
import { sessionsBetween } from './facts/build';
import type { Facts, Mark } from './facts/build';
import { EARNINGS_SIZE_SESSIONS } from './facts/plans';
import type { Plan } from './facts/plans';
import { VOLUME_AVERAGE_BARS, volumeRatio } from './facts/ta';

/**
 * - tag: price is at the level; the entry needs a 4H close back on the plan side.
 * - close: only a daily close past the level counts (every invalidation).
 * - break: a 4H close past the level with a volume ratio of BREAK_VOLUME_RATIO or more.
 * - touch: the level itself is the event (a target, or an at-market entry).
 */
export type TriggerKind = 'tag' | 'close' | 'break' | 'touch';
export type ExplainStatus = 'triggered' | 'waiting' | 'failed' | 'wick';

export const BREAK_VOLUME_RATIO = 1.5;
/** An analysis older than this many sessions is old: the new facts decide. */
export const OLD_ANALYSIS_SESSIONS = 10;

const H4 = 4 * 3600;

export interface StatusResult {
  kind: TriggerKind;
  status: ExplainStatus;
  /** One sentence, with the numbers of the bars. */
  reason: string;
  /** What the alert needs to be a trigger. */
  needs: string;
  /** The day of the bar that decided the status, or null. */
  at: string | null;
}

export function triggerKindOf(role: AlertOrigin['role'], plan: Pick<Plan, 'kind' | 'entryType'>): TriggerKind {
  if (role === 'invalidation') return 'close';
  if (role === 'target' || plan.kind === 'market') return 'touch';
  return plan.entryType === 'stop' ? 'break' : 'tag';
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** The New York date and hour of a Unix time. */
function newYork(t: number): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(t * 1000));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** The session of `date` closed at 16:00 New York time. */
function sessionClosed(date: string, now: number): boolean {
  const ny = newYork(now);
  return ny.date > date || (ny.date === date && ny.hour >= 16);
}

/** Bars from the one that holds `from` on, that are closed at `now`. */
function closedFrom(bars: readonly Bar[], from: number, now: number, length: number, daily: boolean): { bar: Bar; index: number }[] {
  const out: { bar: Bar; index: number }[] = [];
  bars.forEach((bar, index) => {
    const next = bars[index + 1];
    const holdsOrAfter = (next ? next.time : bar.time + length) > from;
    if (!holdsOrAfter) return;
    const closed = next !== undefined || (daily ? sessionClosed(day(bar.time), now) : now - bar.time >= length || sessionClosed(newYork(bar.time).date, now));
    if (closed) out.push({ bar, index });
  });
  return out;
}

export interface StatusInput {
  role: AlertOrigin['role'];
  plan: Plan;
  /** The alert level. */
  level: number;
  firedAt: number;
  now: number;
  bars4h: readonly Bar[];
  bars1d: readonly Bar[];
}

export function statusOf(input: StatusInput): StatusResult {
  const { role, plan, level, firedAt, now } = input;
  const kind = triggerKindOf(role, plan);
  const short = plan.side === 'short';
  // "Past" in the trade direction: below for a short, above for a long.
  const withTrade = (close: number) => (short ? close < level : close > level);
  const inv = plan.invalidation.price;
  const pastInvalidation = (close: number) => (short ? close > inv : close < inv);
  const stopHit = (b: Bar) => (short ? b.high >= plan.stop : b.low <= plan.stop);
  const daily = closedFrom(input.bars1d, firedAt, now, 86_400, true);
  const h4 = closedFrom(input.bars4h, firedAt, now, H4, false);

  if (kind === 'touch') {
    return {
      kind, status: 'triggered', at: day(firedAt), needs: 'Nothing. The level is the event.',
      reason: role === 'target' ? `Price reached T1 ${level}.` : `Price reached ${level}.`,
    };
  }

  if (kind === 'close') {
    const needs = `A daily close ${short ? 'above' : 'below'} ${level}.`;
    const against = (close: number) => (short ? close > level : close < level);
    const hit = daily.find((d) => against(d.bar.close));
    if (hit) return { kind, status: 'triggered', at: day(hit.bar.time), needs, reason: `The daily close of ${hit.bar.close} on ${day(hit.bar.time)} is past ${level}. The ${plan.side} ${plan.kind} plan ends.` };
    const last = daily[daily.length - 1];
    if (last) return { kind, status: 'wick', at: day(last.bar.time), needs, reason: `Price crossed ${level}, but the daily close of ${last.bar.close} on ${day(last.bar.time)} came back. The plan stays valid.` };
    return { kind, status: 'waiting', at: null, needs, reason: `Price crossed ${level}. The daily close is not in yet.` };
  }

  // tag and break: entries. A daily close past the invalidation, or the stop, ends them first.
  const dailyFail = daily.find((d) => pastInvalidation(d.bar.close));
  const ratios = volumeRatio(Float64Array.from(input.bars4h, (b) => b.volume), VOLUME_AVERAGE_BARS);
  const needs =
    kind === 'tag'
      ? `A 4H close back ${short ? 'below' : 'above'} ${level}, or a 4H rejection candle.`
      : `A 4H close ${short ? 'below' : 'above'} ${level}, with a volume ratio of ${BREAK_VOLUME_RATIO} or more.`;
  let weakBreak: { close: number; ratio: number; date: string } | null = null;

  for (const { bar, index } of h4) {
    if (dailyFail && bar.time >= dailyFail.bar.time + 86_400) break;
    if (kind === 'tag' && stopHit(bar)) {
      return { kind, status: 'failed', at: day(bar.time), needs, reason: `Price reached the stop level ${plan.stop} before a 4H close back ${short ? 'below' : 'above'} ${level}. Cancel the plan.` };
    }
    if (!withTrade(bar.close)) continue;
    const ratio = ratios[index];
    const r = ratio !== undefined && Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null;
    if (kind === 'tag') {
      return { kind, status: 'triggered', at: day(bar.time), needs, reason: `The 4H bar of ${day(bar.time)} closed at ${bar.close}, back ${short ? 'below' : 'above'} ${level}. The entry is confirmed.` };
    }
    if (r !== null && r >= BREAK_VOLUME_RATIO) {
      return { kind, status: 'triggered', at: day(bar.time), needs, reason: `The 4H bar of ${day(bar.time)} closed at ${bar.close}, past ${level}, with a volume ratio of ${r}. The break is confirmed.` };
    }
    weakBreak ??= { close: bar.close, ratio: r ?? 0, date: day(bar.time) };
  }

  if (dailyFail) {
    return { kind, status: 'failed', at: day(dailyFail.bar.time), needs, reason: `The daily close of ${dailyFail.bar.close} on ${day(dailyFail.bar.time)} is past the invalidation ${inv}. Cancel the plan.` };
  }
  if (weakBreak) {
    return { kind, status: 'waiting', at: weakBreak.date, needs, reason: `A 4H bar closed at ${weakBreak.close}, past ${level}, but its volume ratio is only ${weakBreak.ratio}. Wait for volume.` };
  }
  return {
    kind, status: 'waiting', at: null, needs,
    reason: kind === 'tag' ? `The alert is the tag, not the entry. No 4H bar closed back ${short ? 'below' : 'above'} ${level} yet.` : `No 4H bar closed past ${level} yet.`,
  };
}

/** The saved plan that made the alert: the featured plan of that name. */
export function savedPlan(saved: Pick<Facts, 'plans' | 'marks'>, name: string): Plan | null {
  const entry = saved.marks.lines.find((l) => l.label === `${name} entry`);
  const stop = saved.marks.lines.find((l) => l.label === `${name} stop`);
  const candidates = saved.plans.filter((p) => `${p.side} ${p.kind}` === name);
  return candidates.find((p) => (stop ? p.stop === stop.price : true) && (entry ? p.entryHigh === entry.price || p.entryLow === entry.price : true)) ?? candidates[0] ?? null;
}

/** The marks of one plan, from the saved facts. */
export function planMarks(saved: Pick<Facts, 'marks'>, name: string): { lines: Mark[]; zones: [] } {
  return { lines: saved.marks.lines.filter((l) => l.label.startsWith(`${name} `)), zones: [] };
}

/** The JSON that the model receives. Every number in it comes from the server. */
export function explainFacts(args: { event: AlertEvent; origin: AlertOrigin; analysisAt: number; saved: Facts; plan: Plan; status: StatusResult; now: Facts; nowTime: number }) {
  const { event, origin, saved, plan, status, now } = args;
  const analysisDay = day(args.analysisAt);
  const today = day(args.nowTime);
  const newEvents = (list: Facts['structure']['events']) => list.filter((e) => e.date > analysisDay);
  const known = new Set(saved.news.map((n) => n.title));
  const sinceAnalysis = sessionsBetween(analysisDay, today);
  return {
    synthetic: now.synthetic,
    dataCheck: now.dataCheck,
    alert: {
      symbol: event.symbol, role: origin.role, plan: origin.plan, level: event.target, direction: event.crossed,
      firedAt: new Date(event.firedAt * 1000).toISOString(), firedPrice: event.value, message: event.message,
    },
    trigger: { kind: status.kind, needs: status.needs },
    status: { status: status.status, reason: status.reason, at: status.at },
    plan,
    risk: { perShare: Number(Math.abs(plan.rrEntry - plan.stop).toFixed(2)), pct: plan.stopPct, hasTarget: plan.targets.length > 0 },
    analysis: {
      askedAt: saved.askedAt, structure: saved.structure, structure4h: saved.structure4h, range: saved.range, fib: saved.fib,
      fvg: saved.fvg, orderBlocks: saved.orderBlocks, confluence: saved.confluence, earnings: saved.earnings,
    },
    now: {
      quote: now.quote, lastBar4h: now.timeframes['4h']?.lastBar ?? null, lastBar1d: now.timeframes['1D']?.lastBar ?? null,
      atr1d: now.timeframes['1D']?.atr ?? null, newStructure: newEvents(now.structure.events), newStructure4h: newEvents(now.structure4h.events),
      news: now.news.filter((n) => n.date >= analysisDay && !known.has(n.title)), earnings: now.earnings, sizePct: now.earnings.sessionsAway !== null && now.earnings.sessionsAway <= EARNINGS_SIZE_SESSIONS ? 0.5 : plan.sizePct,
    },
    age: { sinceAnalysis, sinceFire: sessionsBetween(day(event.firedAt), today), old: sinceAnalysis > OLD_ANALYSIS_SESSIONS, hoursSinceFire: Math.round((args.nowTime - event.firedAt) / 3600) },
  };
}
