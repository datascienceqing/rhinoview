/**
 * News tab: the articles of the server's window (the last two months), newest first,
 * under one heading per New York date. The whole window arrives in one response; the tab
 * shows NEWS_PAGE articles first and "Show more" adds NEWS_PAGE more, so a busy symbol
 * (AAPL: about 1,400 articles) does not put every row in the DOM at once.
 *
 * Times are New York time, like the rest of the app. Links open in a new tab with no
 * opener and no referrer; the server sends only http and https links.
 */
import { useState } from 'react';
import type { NewsArticle, NewsResponse } from '@shared/types';
import { MAX_NEWS_ARTICLES } from '@shared/types';
import { useAsync } from '../data';
import { INTL_LOCALE, useI18n } from '../i18n';
import type { Locale } from '../i18n';
import { fetchNews } from './api';
import { AsyncBlock } from './AsyncBlock';

/** Articles added per "Show more". */
export const NEWS_PAGE = 50;

const NY = 'America/New_York';

interface Formats {
  day: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  /** 'YYYY-MM-DD' in New York, the grouping key. */
  key: Intl.DateTimeFormat;
}

const formatCache = new Map<Locale, Formats>();
function formatsFor(locale: Locale): Formats {
  let f = formatCache.get(locale);
  if (!f) {
    const tag = INTL_LOCALE[locale];
    f = {
      day: new Intl.DateTimeFormat(tag, { timeZone: NY, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }),
      time: new Intl.DateTimeFormat(tag, { timeZone: NY, hour: 'numeric', minute: '2-digit' }),
      key: new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }),
    };
    formatCache.set(locale, f);
  }
  return f;
}

interface DayGroup {
  key: string;
  label: string;
  articles: NewsArticle[];
}

/** Consecutive articles of one New York date. The input is newest first, so the groups are too. */
export function groupByDay(articles: readonly NewsArticle[], locale: Locale): DayGroup[] {
  const f = formatsFor(locale);
  const groups: DayGroup[] = [];
  for (const a of articles) {
    const date = new Date(a.publishedAt * 1000);
    const key = f.key.format(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.articles.push(a);
    else groups.push({ key, label: f.day.format(date), articles: [a] });
  }
  return groups;
}

export function NewsTab({ symbol }: { symbol: string }) {
  const { t } = useI18n();
  const state = useAsync(`news:${symbol}`, () => fetchNews(symbol));
  return (
    <AsyncBlock state={state} loading={t('fund.loadingNews')}>
      {(d) => <NewsBody key={symbol} data={d} />}
    </AsyncBlock>
  );
}

function NewsBody({ data }: { data: NewsResponse }) {
  const { t, locale } = useI18n();
  const [shown, setShown] = useState(NEWS_PAGE);
  const { articles, from, to } = data;
  if (articles.length === 0) return <p className="fund-unavailable">{t('fund.noNews', { from, to })}</p>;

  const visible = articles.slice(0, shown);
  const time = formatsFor(locale).time;
  return (
    <div className="fund-news" data-testid="news-list">
      <p className="fund-news-range">
        {t('fund.newsRange', { count: articles.length, from, to })}
        {data.truncated && <> {t('fund.newsTruncated', { max: MAX_NEWS_ARTICLES })}</>}
      </p>
      {groupByDay(visible, locale).map((g) => (
        <section key={g.key} className="fund-news-day" aria-labelledby={`news-day-${g.key}`}>
          <h3 id={`news-day-${g.key}`}>{g.label}</h3>
          <ul>
            {g.articles.map((a) => (
              <li key={a.url ?? `${a.publishedAt}|${a.title}`} className="fund-news-item" data-testid="news-item">
                <h4>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" title={t('fund.newsOpens')}>
                      {a.title}
                    </a>
                  ) : (
                    a.title
                  )}
                </h4>
                <p className="fund-news-meta">
                  <time dateTime={new Date(a.publishedAt * 1000).toISOString()}>{time.format(new Date(a.publishedAt * 1000))}</time>
                  {a.publisher && <span>{a.publisher}</span>}
                  {a.site && a.site !== a.publisher && <span>{a.site}</span>}
                </p>
                {a.summary && <p className="fund-news-summary">{a.summary}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {shown < articles.length && (
        <div className="fund-news-more">
          <span>{t('fund.newsShown', { shown: visible.length, count: articles.length })}</span>
          <button type="button" className="fund-more" onClick={() => setShown((n) => n + NEWS_PAGE)}>
            {t('fund.showMore')}
          </button>
        </div>
      )}
    </div>
  );
}
