/**
 * Gathers the inputs of `buildFacts` from the market service and the fundamentals
 * provider, and reads the direction and the reason from the question.
 */
import type { Bar, Timeframe } from '@shared/types';
import type { FundamentalsProvider } from '../fundamentals/types';
import type { MarketService } from '../provider/service';
import type { FactsInput } from './facts/build';
import type { Direction } from './facts/plans';

const DAY = 86_400;

/** History for each timeframe: enough for EMA200 on 1D, a 1W leg, and the 4H swings. */
const HISTORY_DAYS: Record<'4h' | '1D' | '1W', number> = { '4h': 120, '1D': 3 * 365, '1W': 8 * 365 };

/**
 * The direction that the question asks about, or null for "is it a good entry?" questions
 * and questions that name both. English and Chinese.
 */
export function directionOf(question: string): Direction | null {
  const q = question.toLowerCase();
  const short = /\b(short|shorting|sell|selling)\b/.test(q) || /做空|卖空|空单/.test(question);
  const long = /\b(long|buy|buying|go long)\b/.test(q) || /做多|买入|多单|抄底/.test(question);
  return short === long ? null : short ? 'short' : 'long';
}

/**
 * The user's reason, when the question gives one: the sentences after the first question,
 * or the part after "because". Null when there is no reason.
 */
export function reasonOf(question: string): string | null {
  const because = /\b(?:because|since|as)\b\s+(.+)$/i.exec(question) ?? /因为(.+)$/.exec(question);
  if (because?.[1]) return because[1].trim();
  const sentences = question.split(/(?<=[?？.!。！])\s*/).map((s) => s.trim()).filter(Boolean);
  return sentences.length > 1 ? sentences.slice(1).join(' ') : null;
}

export interface LoadDeps {
  service: MarketService;
  fundamentals: FundamentalsProvider;
  now: () => number;
  provider: string;
}

/** Throws the service's ApiFailure when the daily bars fail (unknown symbol, no data). Other parts are optional. */
export async function loadFactsInput(deps: LoadDeps, symbol: string, question: string): Promise<FactsInput> {
  const now = deps.now();
  const bars = (tf: Timeframe & keyof typeof HISTORY_DAYS) =>
    deps.service.bars({ symbol, timeframe: tf, from: now - HISTORY_DAYS[tf] * DAY, to: now, adjusted: true }).then((r) => r.bars);
  const optional = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
  const f = deps.fundamentals;

  const [daily, h4, weekly, quote, earnings, overview, news] = await Promise.all([
    bars('1D'),
    optional(bars('4h'), [] as Bar[]),
    optional(bars('1W'), [] as Bar[]),
    optional(deps.service.snapshot(symbol), null),
    f.available ? optional(f.getEarnings(symbol).then((r) => r.events), []) : Promise.resolve([]),
    f.available ? optional(f.getOverview(symbol), null) : Promise.resolve(null),
    f.available ? optional(f.getNews(symbol).then((r) => r.articles), []) : Promise.resolve([]),
  ]);

  return {
    symbol: quote?.symbol ?? symbol.toUpperCase(),
    question,
    askedAt: now,
    direction: directionOf(question),
    reason: reasonOf(question),
    provider: deps.provider,
    quote,
    bars: { '4h': h4, '1D': daily, '1W': weekly },
    earnings,
    analysts: overview && !overview.unavailable.includes('analyst') ? overview.analyst : null,
    news,
  };
}
