/**
 * The `facts` object of the trade-check skill (server/ai/skills/trade-check.md, "Input").
 *
 * Pure: the caller fetches the bars and the fundamentals; this file only calculates. Every
 * number that the model may quote is here, so the model never calculates (docs/AI_HELPER_PLAN.md,
 * section 3). Prices are rounded for the model; the calculations use the raw values.
 */
import type { AnalystConsensus, Bar, EarningsEvent, NewsArticle, Snapshot } from '@shared/types';
import { computeFvg } from '../../../src/indicators/fvg';
import { atr, ema, macd, rsi } from '../../../src/indicators/math';
import { DEFAULT_PARAMS } from '../../../src/indicators/types';
import { scoreConfluence } from './confluence';
import type { Arrow, ConfluenceResult, ConfluenceRow } from './confluence';
import { pctFrom, plansFor } from './plans';
import type { Direction, Level, Plan } from './plans';
import { analyzeStructure, dealingRange, fibOfLastLeg } from './structure';
import type { DealingRange, Fib, StructureEvent, Zone } from './structure';
import { adx, back, bollinger, columns, last, monthlyFromWeekly, rating, volumeRatio, VOLUME_AVERAGE_BARS, volumeSignals } from './ta';
import type { Rating, VolumeSignals } from './ta';

export type FactsTimeframe = '4h' | '1D' | '1W' | '1M';

export interface FactsInput {
  symbol: string;
  question: string;
  /** Unix seconds. */
  askedAt: number;
  direction: Direction | null;
  reason: string | null;
  provider: string;
  quote: Snapshot | null;
  bars: { '4h': readonly Bar[]; '1D': readonly Bar[]; '1W': readonly Bar[] };
  /** Newest first, as the earnings endpoint returns them. Upcoming reports have null actuals. */
  earnings: readonly EarningsEvent[];
  analysts: AnalystConsensus | null;
  /** Newest first. */
  news: readonly NewsArticle[];
}

export interface TimeframeFacts {
  lastBar: { date: string; open: number; high: number; low: number; close: number; volume: number; volumeRatio: number | null };
  rsi: number | null;
  macd: { line: number; signal: number; histogram: number; histogramTrend: 'widening' | 'narrowing'; lastCross: { date: string; side: 'bullish' | 'bearish' } | null } | null;
  atr: number | null;
  atrPct: number | null;
  adx: { adx: number; plusDi: number; minusDi: number } | null;
  bands: { upper: number; lower: number; position: 'above upper' | 'below lower' | 'inside' } | null;
  rating: Rating | null;
}

export interface MaFact {
  name: 'EMA20' | 'EMA50' | 'EMA200';
  value: number;
  slope: 'rising' | 'falling' | 'flat';
  /** (price − MA) / MA, in %. */
  distancePct: number;
  position: 'above' | 'below';
}

export interface Mark {
  price: number;
  label: string;
  role: 'supply' | 'demand' | 'trigger' | 'target' | 'stop';
}

export interface ZoneMark {
  top: number;
  bottom: number;
  label: string;
  role: 'supply' | 'demand';
}

export interface Facts {
  question: string;
  askedAt: string;
  direction: Direction | null;
  reason: string | null;
  symbol: string;
  provider: string;
  synthetic: boolean;
  dataCheck: { lastDailyBar: string | null; staleDays: number | null; stale: boolean; partialSession: boolean; missing: string[] };
  quote: { last: number; change: number | null; changePct: number | null } | null;
  recentMove: { sessions: number; fromClose: number; toClose: number; pct: number }[];
  timeframes: Partial<Record<FactsTimeframe, TimeframeFacts>>;
  mas: MaFact[];
  maOrder: string | null;
  structure: { trend: string | null; events: (Omit<StructureEvent, 'index' | 'time'> & { date: string })[] };
  structure4h: { trend: string | null; events: (Omit<StructureEvent, 'index' | 'time'> & { date: string })[] };
  swings: { kind: 'high' | 'low'; date: string; price: number }[];
  range: DealingRange | null;
  fib: (Omit<Fib, 'from' | 'to'> & { from: { price: number; date: string }; to: { price: number; date: string } }) | null;
  fvg: { side: 'bullish' | 'bearish'; top: number; bottom: number; date: string; touched: boolean; priceInside: boolean }[];
  orderBlocks: (Omit<Zone, 'index' | 'time' | 'createdIndex'> & { date: string })[];
  volumeSignals: (Omit<VolumeSignals, 'capitulation'> & { capitulation: { date: string; ratio: number } | null }) | null;
  /** Revenue in millions of the reporting currency. */
  lastReport: { date: string; epsActual: number | null; epsEstimate: number | null; revenueActualMillions: number | null; revenueEstimateMillions: number | null; sessionsAgo: number } | null;
  earnings: { next: string | null; sessionsAway: number | null };
  analysts: (AnalystConsensus & { consensusPct: number | null; highPct: number | null; lowPct: number | null }) | null;
  news: { date: string; title: string; publisher: string | null; summary: string | null; url: string | null }[];
  confluence: ConfluenceResult;
  plans: Plan[];
  marks: { lines: Mark[]; zones: ZoneMark[] };
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
/** Prices to 2 decimals (4 under $1); ratios and percents to 2 decimals. */
const px = (v: number) => Number(v.toFixed(Math.abs(v) < 1 ? 4 : 2));
const r2 = (v: number) => Number(v.toFixed(2));

/** Weekdays after `fromDay` up to and including `toDay` ('YYYY-MM-DD'). Holidays are not known. */
export function sessionsBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  const sign = b >= a ? 1 : -1;
  let n = 0;
  for (let t = Math.min(a, b) + 86_400_000; t <= Math.max(a, b); t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return sign * n;
}

/** The New York calendar day and hour of a Unix time. */
function newYork(t: number): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(t * 1000));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

function timeframeFacts(bars: readonly Bar[]): TimeframeFacts | null {
  const b = bars[bars.length - 1];
  if (!b) return null;
  const c = columns(bars);
  const a = atr(c.high, c.low, c.close, 14);
  const m = macd(c.close, 12, 26, 9);
  const d = adx(c.high, c.low, c.close, 14);
  const bb = bollinger(c.close, 20, 2);
  const vr = last(volumeRatio(c.volume, VOLUME_AVERAGE_BARS));
  const line = last(m.macd);
  const signal = last(m.signal);
  const hist = last(m.histogram);
  const histPrev = back(m.histogram, 1);
  let lastCross: NonNullable<TimeframeFacts['macd']>['lastCross'] = null;
  for (let i = bars.length - 1; i > 0; i--) {
    const h0 = m.histogram[i] as number;
    const h1 = m.histogram[i - 1] as number;
    if (Number.isFinite(h0) && Number.isFinite(h1) && Math.sign(h0) !== Math.sign(h1) && h0 !== 0) {
      lastCross = { date: day((bars[i] as Bar).time), side: h0 > 0 ? 'bullish' : 'bearish' };
      break;
    }
  }
  const atrNow = last(a);
  const upper = last(bb.upper);
  const lower = last(bb.lower);
  const adxNow = last(d.adx);
  return {
    lastBar: { date: day(b.time), open: px(b.open), high: px(b.high), low: px(b.low), close: px(b.close), volume: b.volume, volumeRatio: vr === null ? null : r2(vr) },
    rsi: last(rsi(c.close, 14)),
    macd: line !== null && signal !== null && hist !== null
      ? { line: r2(line), signal: r2(signal), histogram: r2(hist), histogramTrend: histPrev !== null && Math.abs(hist) > Math.abs(histPrev) ? 'widening' : 'narrowing', lastCross }
      : null,
    atr: atrNow === null ? null : px(atrNow),
    atrPct: atrNow === null ? null : r2((atrNow / b.close) * 100),
    adx: adxNow === null ? null : { adx: r2(adxNow), plusDi: r2(last(d.plusDi) ?? 0), minusDi: r2(last(d.minusDi) ?? 0) },
    bands: upper === null || lower === null ? null : { upper: px(upper), lower: px(lower), position: b.close > upper ? 'above upper' : b.close < lower ? 'below lower' : 'inside' },
    rating: rating(bars),
  };
}

function ratingArrow(r: Rating | null | undefined): Arrow {
  if (!r) return 'neutral';
  return r.label.endsWith('Buy') ? 'up' : r.label.endsWith('Sell') ? 'down' : 'neutral';
}

const eventFact = (bars: readonly Bar[]) => (e: StructureEvent) => ({ kind: e.kind, side: e.side, level: px(e.level), date: day((bars[e.index] as Bar).time) });

/** Zones drawn on the chart: the nearest ones to the price. */
export const MAX_ZONE_MARKS = 4;

/**
 * The plan to draw for one side: the retest or continuation plan with the best T1 R:R among
 * those that reach 2:1; else the at-market plan when it reaches 2:1; else none.
 */
export function featuredPlan<P extends { kind: string; meetsTwoToOne: boolean; targets: { rr: number }[] }>(plans: readonly P[]): P | null {
  const ok = plans.filter((p) => p.meetsTwoToOne);
  const pending = ok.filter((p) => p.kind !== 'market').sort((a, b) => (b.targets[0]?.rr ?? 0) - (a.targets[0]?.rr ?? 0));
  return pending[0] ?? ok.find((p) => p.kind === 'market') ?? null;
}

export function buildFacts(input: FactsInput): Facts {
  const daily = input.bars['1D'];
  const missing: string[] = [];
  const lastDaily = daily[daily.length - 1];
  const price = input.quote?.price ?? lastDaily?.close ?? NaN;

  // ── Data check ──
  const asked = newYork(input.askedAt);
  const lastDay = lastDaily ? newYork(lastDaily.time).date : null;
  const staleDays = lastDay ? sessionsBetween(lastDay, asked.date) : null;
  // The last bar is today's while the session is open, or yesterday's after a weekend.
  const partialSession = lastDay === asked.date && asked.hour >= 9 && asked.hour < 16;
  const stale = staleDays !== null && (staleDays > 1 || (staleDays === 1 && asked.hour >= 16));

  // ── Timeframes ──
  const monthly = monthlyFromWeekly(input.bars['1W']);
  const timeframes: Facts['timeframes'] = {};
  for (const [tf, bars] of [['4h', input.bars['4h']], ['1D', daily], ['1W', input.bars['1W']], ['1M', monthly]] as const) {
    const f = timeframeFacts(bars);
    if (f) timeframes[tf] = f;
    else missing.push(`bars ${tf}`);
  }
  const d1 = timeframes['1D'];
  const atrDaily = d1?.atr ?? NaN;
  const atrLower = timeframes['4h']?.atr ?? NaN;
  if (!Number.isFinite(atrLower)) missing.push('atr 4h');

  // ── MAs ──
  const c = columns(daily);
  const mas: MaFact[] = [];
  for (const [name, period] of [['EMA20', 20], ['EMA50', 50], ['EMA200', 200]] as const) {
    const series = ema(c.close, period);
    const v = last(series);
    const v5 = back(series, 5);
    if (v === null || daily.length < period) {
      missing.push(name);
      continue;
    }
    const slope = v5 === null ? 'flat' : v > v5 ? 'rising' : v < v5 ? 'falling' : 'flat';
    mas.push({ name, value: px(v), slope, distancePct: r2(pctFrom(price, v)), position: price >= v ? 'above' : 'below' });
  }
  const maOrder = mas.length === 3 ? [...mas].sort((a, b) => b.value - a.value).map((m) => m.name).join(' > ') : null;

  // ── Structure, zones ──
  const s1 = analyzeStructure(daily);
  const s4 = analyzeStructure(input.bars['4h']);
  const sw = analyzeStructure(input.bars['1W']);
  const range = dealingRange(daily, s1.swings);
  const fibRaw = fibOfLastLeg(input.bars['1W']);
  const fvgRaw = computeFvg(daily, DEFAULT_PARAMS.fvg).zones.filter((z) => z.fillIndex === null);
  const fvg = fvgRaw
    .map((z) => ({
      side: z.side === 'bull' ? ('bullish' as const) : ('bearish' as const),
      top: px(z.top), bottom: px(z.bottom), date: day((daily[z.startIndex] as Bar).time),
      touched: z.touchIndex !== null, priceInside: price >= z.bottom && price <= z.top,
    }))
    .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price))
    .slice(0, 4);
  const vs = daily.length ? volumeSignals(daily, atr(c.high, c.low, c.close, 14)) : null;

  // ── Fundamentals ──
  const todayDay = asked.date;
  const reported = input.earnings.filter((e) => e.epsActual !== null || e.revenueActual !== null);
  const upcoming = input.earnings.filter((e) => e.epsActual === null && e.revenueActual === null && e.date >= todayDay);
  const nextReport = upcoming[upcoming.length - 1]?.date ?? null;
  const lastRep = reported[0];
  const earningsSessions = nextReport ? sessionsBetween(todayDay, nextReport) : null;
  if (!nextReport) missing.push('next earnings date');
  const pctOf = (v: number | null) => (v === null || !Number.isFinite(price) ? null : r2(pctFrom(v, price)));

  // ── Confluence ──
  const rows: ConfluenceRow[] = [];
  for (const tf of ['1D', '4h', '1W', '1M'] as const) {
    const f = timeframes[tf];
    if (!f?.rating) continue;
    const parts = [`${f.rating.label} (${r2(f.rating.score)})`];
    if (f.rsi !== null) parts.push(`RSI ${r2(f.rsi)}`);
    if (f.macd) parts.push(`MACD ${f.macd.line} vs signal ${f.macd.signal}`);
    if (f.adx) parts.push(`ADX ${f.adx.adx}`);
    rows.push({ id: `rating-${tf}`, signal: `${tf} rating`, reading: parts.join(', '), arrow: ratingArrow(f.rating) });
  }
  if (mas.length === 3) {
    const above = mas.filter((m) => m.position === 'above').length;
    rows.push({
      id: 'mas', signal: 'Daily MAs',
      reading: mas.map((m) => `${m.distancePct}% ${m.position} ${m.name} (${m.slope})`).join(', '),
      arrow: above === 3 ? 'up' : above === 0 ? 'down' : 'neutral',
    });
  }
  const lastEvent = s1.events[s1.events.length - 1];
  if (lastEvent) {
    rows.push({ id: 'structure', signal: 'Daily structure', reading: `${lastEvent.side} ${lastEvent.kind} at ${px(lastEvent.level)} on ${day(lastEvent.time)}`, arrow: lastEvent.side === 'bullish' ? 'up' : 'down' });
  }
  if (d1?.lastBar.volumeRatio != null && daily.length > 1) {
    const prev = daily[daily.length - 2] as Bar;
    const up = (lastDaily as Bar).close >= prev.close;
    const strong = d1.lastBar.volumeRatio >= 1.5;
    rows.push({ id: 'volume', signal: 'Volume on the last bar', reading: `${d1.lastBar.volumeRatio}× the ${VOLUME_AVERAGE_BARS}-bar average on ${up ? 'an up' : 'a down'} bar`, arrow: strong ? (up ? 'up' : 'down') : 'neutral' });
  }
  {
    const low = [timeframes['1D'], timeframes['4h']].some((f) => (f?.rsi ?? 50) < 30 || f?.bands?.position === 'below lower');
    const high = [timeframes['1D'], timeframes['4h']].some((f) => (f?.rsi ?? 50) > 70 || f?.bands?.position === 'above upper');
    const reading = (['1D', '4h'] as const).map((tf) => `${tf} RSI ${r2(timeframes[tf]?.rsi ?? NaN)}, ${timeframes[tf]?.bands?.position ?? 'no bands'}`).join('; ');
    rows.push({ id: 'exhaustion', signal: 'Exhaustion', reading, arrow: low && !high ? 'up' : high && !low ? 'down' : 'neutral' });
  }
  if (d1?.adx) {
    const { adx: a, plusDi, minusDi } = d1.adx;
    rows.push({ id: 'trend-strength', signal: 'Trend strength (1D ADX)', reading: `ADX ${a}, +DI ${plusDi}, −DI ${minusDi}`, arrow: a < 20 ? 'neutral' : plusDi > minusDi ? 'up' : 'down' });
  }
  if (sw.trend) rows.push({ id: 'weekly-structure', signal: 'Weekly structure', reading: `${sw.trend} trend`, arrow: sw.trend === 'bullish' ? 'up' : 'down' });
  if (lastRep && sessionsBetween(lastRep.date, todayDay) <= 10 && lastRep.epsActual !== null && lastRep.epsEstimate !== null) {
    const beat = lastRep.epsActual > lastRep.epsEstimate;
    rows.push({ id: 'catalyst', signal: 'Last report', reading: `EPS ${lastRep.epsActual} against an estimate of ${lastRep.epsEstimate} on ${lastRep.date}`, arrow: beat ? 'up' : lastRep.epsActual < lastRep.epsEstimate ? 'down' : 'neutral' });
  }
  if (input.analysts && input.analysts.targetConsensus !== null && Number.isFinite(price)) {
    const a = input.analysts;
    const buys = (a.strongBuy ?? 0) + (a.buy ?? 0);
    const sells = (a.strongSell ?? 0) + (a.sell ?? 0);
    const upside = pctFrom(a.targetConsensus as number, price);
    rows.push({
      id: 'analysts', signal: 'Analyst consensus',
      reading: `${buys} buy / ${a.hold ?? 0} hold / ${sells} sell, consensus target ${px(a.targetConsensus as number)} (${r2(upside)}%)`,
      arrow: buys > sells && upside > 10 ? 'up' : sells > buys || upside < 0 ? 'down' : 'neutral',
    });
  }
  const confluence = scoreConfluence(rows, input.direction);

  // ── Plans ──
  const ema200 = mas.find((m) => m.name === 'EMA200');
  const weekly = timeframes['1W']?.rating;
  const againstTrend: Record<Direction, boolean> = {
    long: (weekly?.label.endsWith('Sell') ?? false) || ema200?.position === 'below',
    short: (weekly?.label.endsWith('Buy') ?? false) || ema200?.position === 'above',
  };
  const levels: Level[] = [
    ...s1.swings.slice(-20).map((s) => ({ price: s.price, label: `${s.kind === 'high' ? 'swing high' : 'swing low'} ${day(s.time)}` })),
    ...s1.events.slice(-4).map((e) => ({ price: e.level, label: `${e.side} ${e.kind} level ${day(e.time)}` })),
    ...fvgRaw.flatMap((z) => [{ price: z.top, label: `${z.side === 'bull' ? 'bullish' : 'bearish'} FVG top` }, { price: z.bottom, label: `${z.side === 'bull' ? 'bullish' : 'bearish'} FVG bottom` }]),
    ...s1.orderBlocks.flatMap((z) => [{ price: z.top, label: `${z.side} order block top` }, { price: z.bottom, label: `${z.side} order block bottom` }]),
    ...(fibRaw ? fibRaw.levels.filter((l) => l.ratio > 0 && l.ratio < 1).map((l) => ({ price: l.price, label: `weekly fib ${l.name}` })) : []),
    ...mas.map((m) => ({ price: m.value, label: m.name })),
  ];
  const lastBreak = (side: 'bullish' | 'bearish') => {
    const e = [...s1.events].reverse().find((x) => x.side === side);
    return e ? { price: e.level, label: `${side === 'bearish' ? 'broken support' : 'broken resistance'} ${px(e.level)}` } : null;
  };
  const plans: Plan[] = [];
  if (Number.isFinite(price) && Number.isFinite(atrDaily) && Number.isFinite(atrLower)) {
    const ctx = { price, atrDaily, atrLower, levels, lastBearishBreak: lastBreak('bearish'), lastBullishBreak: lastBreak('bullish'), againstTrend, earningsSessions };
    for (const side of input.direction ? [input.direction] : (['long', 'short'] as const)) plans.push(...plansFor(side, ctx));
  }
  const roundedPlans = plans.map((p) => ({
    ...p,
    entryLow: px(p.entryLow), entryHigh: px(p.entryHigh), rrEntry: px(p.rrEntry), stop: px(p.stop), stopPct: r2(p.stopPct),
    invalidation: { ...p.invalidation, price: px(p.invalidation.price) },
    stopRule: { ...p.stopRule, invalidation: px(p.stopRule.invalidation), atrLower: px(p.stopRule.atrLower) },
    targets: p.targets.map((t) => ({ ...t, price: px(t.price), pct: r2(t.pct), rr: r2(t.rr) })),
  }));

  // ── Chart marks: from the plans and the zones, never from the model text ──
  // One featured plan per side keeps the price scale readable (all plans drew 23 levels).
  const featured = (['long', 'short'] as const).flatMap((side) => {
    const best = featuredPlan(roundedPlans.filter((p) => p.side === side));
    return best ? [best] : [];
  });
  const lines: Mark[] = [];
  const addLine = (m: Mark) => {
    if (!lines.some((l) => Math.abs(l.price - m.price) < 1e-9)) lines.push(m);
  };
  for (const p of featured) {
    const name = `${p.side} ${p.kind}`;
    if (p.kind !== 'market') addLine({ price: p.entryType === 'limit' ? p.entryHigh : p.entryLow, label: `${name} entry`, role: 'trigger' });
    addLine({ price: p.stop, label: `${name} stop`, role: 'stop' });
    p.targets.slice(0, 2).forEach((t, i) => addLine({ price: t.price, label: `${name} T${i + 1}`, role: 'target' }));
  }
  const zones: ZoneMark[] = [
    ...fvg.map((z) => ({ top: z.top, bottom: z.bottom, label: `${z.side} FVG`, role: z.side === 'bullish' ? ('demand' as const) : ('supply' as const) })),
    ...s1.orderBlocks.map((z) => ({ top: px(z.top), bottom: px(z.bottom), label: `${z.side} order block`, role: z.side === 'bullish' ? ('demand' as const) : ('supply' as const) })),
  ]
    .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price))
    .slice(0, MAX_ZONE_MARKS);

  // ── Recent move ──
  const recentMove = [1, 3, 5].flatMap((k) => {
    const from = daily[daily.length - 1 - k];
    if (!from || !lastDaily) return [];
    return [{ sessions: k, fromClose: px(from.close), toClose: px(lastDaily.close), pct: r2(pctFrom(lastDaily.close, from.close)) }];
  });

  if (!input.analysts) missing.push('analysts');
  if (input.news.length === 0) missing.push('news');
  if (!s1.events.length) missing.push('daily structure events');

  return {
    question: input.question,
    askedAt: new Date(input.askedAt * 1000).toISOString(),
    direction: input.direction,
    reason: input.reason,
    symbol: input.symbol,
    provider: input.provider,
    synthetic: input.provider === 'synthetic' || input.provider === 'mock',
    dataCheck: { lastDailyBar: lastDay, staleDays, stale, partialSession, missing },
    quote: input.quote?.price != null
      ? { last: px(input.quote.price), change: input.quote.change === null ? null : px(input.quote.change), changePct: input.quote.changePercent === null ? null : r2(input.quote.changePercent * 100) }
      : null,
    recentMove,
    timeframes,
    mas,
    maOrder,
    structure: { trend: s1.trend, events: s1.events.slice(-6).map(eventFact(daily)) },
    structure4h: { trend: s4.trend, events: s4.events.slice(-4).map(eventFact(input.bars['4h'])) },
    swings: s1.swings.slice(-8).map((s) => ({ kind: s.kind, date: day(s.time), price: px(s.price) })),
    range: range ? { ...range, high: px(range.high), low: px(range.low), equilibrium: px(range.equilibrium), positionPct: r2(range.positionPct) } : null,
    fib: fibRaw
      ? {
          ...fibRaw,
          from: { price: px(fibRaw.from.price), date: day(fibRaw.from.time) },
          to: { price: px(fibRaw.to.price), date: day(fibRaw.to.time) },
          retracementPct: r2(fibRaw.retracementPct),
          levels: fibRaw.levels.map((l) => ({ ...l, price: px(l.price) })),
          above: fibRaw.above ? { ...fibRaw.above, price: px(fibRaw.above.price) } : null,
          below: fibRaw.below ? { ...fibRaw.below, price: px(fibRaw.below.price) } : null,
        }
      : null,
    fvg,
    orderBlocks: s1.orderBlocks.map(({ index: _i, time, createdIndex: _c, ...z }) => ({ ...z, top: px(z.top), bottom: px(z.bottom), date: day(time) })),
    volumeSignals: vs ? { dryUp: vs.dryUp, recentRatio: vs.recentRatio === null ? null : r2(vs.recentRatio), capitulation: vs.capitulation ? { date: day(vs.capitulation.time), ratio: r2(vs.capitulation.ratio) } : null } : null,
    lastReport: lastRep
      ? {
          date: lastRep.date, epsActual: lastRep.epsActual, epsEstimate: lastRep.epsEstimate,
          revenueActualMillions: lastRep.revenueActual === null ? null : r2(lastRep.revenueActual / 1e6),
          revenueEstimateMillions: lastRep.revenueEstimate === null ? null : r2(lastRep.revenueEstimate / 1e6),
          sessionsAgo: sessionsBetween(lastRep.date, todayDay),
        }
      : null,
    earnings: { next: nextReport, sessionsAway: earningsSessions },
    analysts: input.analysts ? { ...input.analysts, consensusPct: pctOf(input.analysts.targetConsensus), highPct: pctOf(input.analysts.targetHigh), lowPct: pctOf(input.analysts.targetLow) } : null,
    news: input.news.slice(0, 5).map((n) => ({ date: day(n.publishedAt), title: n.title, publisher: n.publisher, summary: n.summary, url: n.url })),
    confluence,
    plans: roundedPlans,
    marks: { lines, zones },
  };
}
