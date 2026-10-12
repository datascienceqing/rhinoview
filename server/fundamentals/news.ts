/**
 * News rules that every fundamentals provider shares (invariant 11): the date window,
 * the link check, and the final order, duplicate removal and cap.
 */
import type { NewsArticle, NewsResponse } from '@shared/types';
import { MAX_NEWS_ARTICLES, NEWS_WINDOW_MONTHS } from '@shared/types';
import { civilToDay, dayStartUnix, dayToCivil, nyDayOf } from '../market/calendar';
import { dayNumberToDate } from '../market/fmp/time';

export interface NewsWindow {
  /** New York dates, 'YYYY-MM-DD', both included. */
  from: string;
  to: string;
  /** 00:00 New York of `from`, Unix seconds: the oldest publication time in the window. */
  fromSeconds: number;
}

/**
 * Today (New York) back NEWS_WINDOW_MONTHS calendar months. The day is clamped to the
 * length of the earlier month, so 2026-04-30 starts at 2026-02-28.
 */
export function newsWindow(nowMs: number): NewsWindow {
  const today = nyDayOf(Math.floor(nowMs / 1000));
  const { year, month, day } = dayToCivil(today);
  const monthIndex = year * 12 + (month - 1) - NEWS_WINDOW_MONTHS;
  const fromYear = Math.floor(monthIndex / 12);
  const fromMonth = (monthIndex % 12) + 1;
  // The day before the 1st of the next month is the last day of this one.
  const next = monthIndex + 1;
  const lastDay = dayToCivil(civilToDay(Math.floor(next / 12), (next % 12) + 1, 1) - 1).day;
  const fromDay = civilToDay(fromYear, fromMonth, Math.min(day, lastDay));
  return { from: dayNumberToDate(fromDay), to: dayNumberToDate(today), fromSeconds: dayStartUnix(fromDay) };
}

/** The URL when it is an absolute http or https link, else null. The UI puts it in an `href`. */
export function safeHttpUrl(text: string | null): string | null {
  if (text === null) return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Keep the articles inside the window (a provider can return a few outside it), remove
 * duplicates, sort newest first and cut to MAX_NEWS_ARTICLES. Duplicates happen when FMP
 * pages shift while a new article arrives between two page requests.
 * `more` is true when the provider stopped before the end of the window.
 */
export function finishNews(
  symbol: string,
  window: NewsWindow,
  nowMs: number,
  articles: readonly NewsArticle[],
  more: boolean,
): NewsResponse {
  const nowSeconds = Math.floor(nowMs / 1000);
  const seen = new Set<string>();
  const kept: NewsArticle[] = [];
  for (const a of articles) {
    if (a.publishedAt < window.fromSeconds || a.publishedAt > nowSeconds) continue;
    const key = a.url ?? `${a.publishedAt}|${a.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(a);
  }
  kept.sort((a, b) => b.publishedAt - a.publishedAt);
  return {
    symbol,
    from: window.from,
    to: window.to,
    articles: kept.slice(0, MAX_NEWS_ARTICLES),
    truncated: more || kept.length > MAX_NEWS_ARTICLES,
  };
}
