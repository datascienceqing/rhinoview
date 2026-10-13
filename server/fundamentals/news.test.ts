/** Invariant 11: the news window, the link check, and order, duplicates and cap. */
import { describe, expect, it } from 'vitest';
import type { NewsArticle } from '@shared/types';
import { MAX_NEWS_ARTICLES } from '@shared/types';
import { finishNews, newsWindow, safeHttpUrl } from './news';

const utc = (iso: string) => Date.parse(iso);

describe('newsWindow', () => {
  it('covers two calendar months back to today, New York dates', () => {
    expect(newsWindow(utc('2026-10-12T21:15:00Z'))).toMatchObject({ from: '2026-08-12', to: '2026-10-12' });
  });

  it('uses the New York date, not the UTC date', () => {
    // 02:00 UTC on the 13th is 22:00 on the 12th in New York (EDT).
    expect(newsWindow(utc('2026-10-13T02:00:00Z'))).toMatchObject({ from: '2026-08-12', to: '2026-10-12' });
  });

  it('crosses a year boundary', () => {
    expect(newsWindow(utc('2026-01-15T17:00:00Z'))).toMatchObject({ from: '2025-11-15', to: '2026-01-15' });
  });

  it('clamps the day to the length of the earlier month', () => {
    expect(newsWindow(utc('2026-04-30T17:00:00Z')).from).toBe('2026-02-28');
    expect(newsWindow(utc('2028-04-30T17:00:00Z')).from).toBe('2028-02-29');
  });

  it('starts at 00:00 New York of the first day', () => {
    // 2026-08-12 is in EDT, UTC-4.
    expect(newsWindow(utc('2026-10-12T21:15:00Z')).fromSeconds).toBe(utc('2026-08-12T04:00:00Z') / 1000);
  });
});

describe('safeHttpUrl', () => {
  it('keeps http and https links', () => {
    expect(safeHttpUrl('https://www.example.com/a?b=1')).toBe('https://www.example.com/a?b=1');
    expect(safeHttpUrl(' http://example.com/x ')).toBe('http://example.com/x');
  });

  it('rejects every other scheme, relative links and text that is not a URL', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'ftp://example.com', '/news/1', 'not a url']) {
      expect(safeHttpUrl(bad), bad).toBeNull();
    }
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe('finishNews', () => {
  const now = utc('2026-10-12T21:15:00Z');
  const window = newsWindow(now);
  const at = (iso: string) => utc(iso) / 1000;
  const article = (iso: string, url: string | null, title = 'T'): NewsArticle => ({
    publishedAt: at(iso),
    title,
    summary: null,
    publisher: null,
    site: null,
    url,
  });

  it('sorts newest first and states the window', () => {
    const res = finishNews('AAPL', window, now, [article('2026-09-01T12:00:00Z', 'https://e.com/1'), article('2026-10-01T12:00:00Z', 'https://e.com/2')], false);
    expect(res).toMatchObject({ symbol: 'AAPL', from: '2026-08-12', to: '2026-10-12', truncated: false });
    expect(res.articles.map((a) => a.url)).toEqual(['https://e.com/2', 'https://e.com/1']);
  });

  it('drops articles before the window and after now', () => {
    const res = finishNews('AAPL', window, now, [
      article('2026-08-12T03:59:59Z', 'https://e.com/before'), // 23:59:59 on 08-11 in New York
      article('2026-08-12T04:00:00Z', 'https://e.com/first'),
      article('2026-10-12T21:15:01Z', 'https://e.com/future'),
    ], false);
    expect(res.articles.map((a) => a.url)).toEqual(['https://e.com/first']);
  });

  it('removes duplicates by link, or by time and title when there is no link', () => {
    const res = finishNews('AAPL', window, now, [
      article('2026-09-01T12:00:00Z', 'https://e.com/1'),
      article('2026-09-01T12:00:00Z', 'https://e.com/1'),
      article('2026-09-02T12:00:00Z', null, 'Same'),
      article('2026-09-02T12:00:00Z', null, 'Same'),
      article('2026-09-02T12:00:00Z', null, 'Other'),
    ], false);
    expect(res.articles).toHaveLength(3);
  });

  it('cuts to MAX_NEWS_ARTICLES, keeps the newest, and reports the cut', () => {
    const many = Array.from({ length: MAX_NEWS_ARTICLES + 5 }, (_, i) =>
      article(new Date(now - (i + 1) * 60_000).toISOString(), `https://e.com/${i}`),
    );
    const res = finishNews('AAPL', window, now, many, false);
    expect(res.articles).toHaveLength(MAX_NEWS_ARTICLES);
    expect(res.articles[0]?.url).toBe('https://e.com/0');
    expect(res.truncated).toBe(true);
  });

  it('reports truncated when the provider stopped early', () => {
    expect(finishNews('AAPL', window, now, [], true).truncated).toBe(true);
  });
});
