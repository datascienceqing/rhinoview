import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarningsResponse, FundamentalsOverview, NewsArticle, NewsResponse } from '@shared/types';
import { fail, ok } from '../../mocks/envelope';
import { newsFor, overviewFor } from '../../mocks/fundamentalsData';
import { server } from '../../mocks/server';
import { resetCapabilitiesCache } from '../data';
import { renderWithDataSource } from '../ui/testUtils';
import { resetFundamentalsCache } from './api';
import { EarningsTab } from './EarningsTab';
import { FundamentalsDrawer } from './FundamentalsDrawer';
import { useEarningsMarkers } from './useEarningsMarkers';

beforeEach(() => {
  resetFundamentalsCache();
  resetCapabilitiesCache();
});

const drawer = (symbol: string) => renderWithDataSource(<FundamentalsDrawer symbol={symbol} onClose={() => undefined} />);
const metric = async (key: string) => (await screen.findByTestId(`metric-${key}`));

describe('Overview tab', () => {
  it('shows a negative P/E as NM with a tooltip (RIVN)', async () => {
    drawer('RIVN');
    const pe = await metric('peRatio');
    expect(pe).toHaveTextContent('NM');
    expect(pe).toHaveAttribute('title', 'not meaningful: negative earnings');
    expect(await metric('evToEbitda')).toHaveTextContent('NM');
    expect(await metric('grossMargin')).not.toHaveTextContent('NM');
  });

  it('shows NM for a lender\u2019s gross margin only (JPM), with the reason, and keeps operating and net margin', async () => {
    drawer('JPM');
    const gross = await metric('grossMargin');
    expect(gross).toHaveTextContent('NM');
    expect(gross.getAttribute('title')).toMatch(/interest expense/);
    for (const k of ['operatingMargin', 'netMargin', 'returnOnEquity']) {
      const cell = await metric(k);
      expect(cell).toHaveTextContent('%');
      expect(cell).not.toHaveTextContent('NM');
    }
    expect(await metric('peRatio')).toHaveTextContent('9.53x');
  });

  it('shows every margin for a Financial Services company that is not a lender (like Visa)', async () => {
    // The old rule hid all margins for the whole sector. The sector alone must not matter now.
    const jpm = overviewFor('JPM');
    const visaLike: FundamentalsOverview = {
      ...jpm,
      profile: { ...jpm.profile, sector: 'Financial Services', industry: 'Financial - Credit Services' },
      grossMarginNotMeaningful: false,
    };
    server.use(http.get('*/api/fundamentals/overview', () => ok(visaLike)));
    drawer('JPM');
    for (const k of ['grossMargin', 'operatingMargin', 'netMargin']) {
      expect(await metric(k)).not.toHaveTextContent('NM');
    }
  });

  it('shows fractions as percentages (AAPL gross margin)', async () => {
    drawer('AAPL');
    expect(await metric('grossMargin')).toHaveTextContent('44.00%');
  });

  it('labels per-share values with the reporting currency, not the trading currency (TSM)', async () => {
    drawer('TSM');
    await metric('epsDiluted');
    expect(screen.getByRole('heading', { name: 'Per share (TWD)' })).toBeInTheDocument();
    expect(screen.getByText('Reports in').nextSibling).toHaveTextContent('TWD');
  });

  it('labels the TTM per-share earnings as EPS (TTM), not diluted EPS', async () => {
    drawer('AAPL');
    await metric('epsDiluted');
    expect(screen.getByText('EPS (TTM)')).toHaveAttribute('title', 'Net income per share, trailing twelve months');
    expect(screen.queryByText('EPS (diluted)')).toBeNull();
  });

  it('shows null as a dash', async () => {
    const o: FundamentalsOverview = overviewFor('AAPL');
    o.metrics.pegRatio = null;
    o.scores.altmanZScore = null;
    server.use(http.get('*/api/fundamentals/overview', () => ok(o)));
    drawer('AAPL');
    expect(await metric('pegRatio')).toHaveTextContent('—');
    expect(screen.getByTestId('altman')).toHaveTextContent('—');
  });

  it('shows Piotroski and Altman scores and the analyst consensus with the price target range', async () => {
    drawer('AAPL');
    expect(await screen.findByTestId('piotroski')).not.toHaveTextContent('—');
    expect(screen.getByTestId('altman')).not.toHaveTextContent('—');
    expect(screen.getByTestId('consensus')).toHaveTextContent(/\w/);
    expect(screen.getByTestId('target-range')).toHaveTextContent(/Low .*High/);
    // The mock snapshot price arrives from the quote request.
    await waitFor(() => expect(screen.getByTestId('target-range')).not.toHaveTextContent('Current price —'));
  });

  it('shows "Not available" for each unavailable section instead of dashes', async () => {
    const o = overviewFor('AAPL');
    o.unavailable = ['metrics', 'scores', 'analyst'];
    server.use(http.get('*/api/fundamentals/overview', () => ok(o)));
    drawer('AAPL');
    for (const s of ['metrics', 'scores', 'analyst']) {
      expect(await screen.findByTestId(`unavailable-${s}`)).toHaveTextContent('Not available');
    }
    expect(screen.queryByTestId('metric-peRatio')).toBeNull();
  });

  it('shows an error with retry for a server failure', async () => {
    server.use(http.get('*/api/fundamentals/overview', () => fail({ code: 'UPSTREAM_ERROR', message: 'x' })));
    drawer('AAPL');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Statements tab', () => {
  it('labels columns with fiscal periods and shows the reporting currency (TSM, TWD)', async () => {
    const user = userEvent.setup();
    drawer('TSM');
    await user.click(screen.getByRole('tab', { name: 'Statements' }));
    expect(await screen.findByTestId('reported-currency')).toHaveTextContent('Reported in TWD');
    expect(screen.getByRole('columnheader', { name: 'FY2025' })).toBeInTheDocument();
    // Revenue formatted with a T suffix, not raw digits.
    const revenue = screen.getByRole('row', { name: /^Revenue/ });
    expect(within(revenue).getAllByRole('cell')[0]).toHaveTextContent(/\dT$/);
  });

  it('uses quarter labels from the provider for a June fiscal year (MSFT)', async () => {
    const user = userEvent.setup();
    drawer('MSFT');
    await user.click(screen.getByRole('tab', { name: 'Statements' }));
    await screen.findByTestId('reported-currency');
    await user.click(screen.getByRole('button', { name: 'Quarterly' }));
    // FY2026 Q1 ended 2025-09-30: the label is the fiscal one, not a calendar quarter.
    const q1 = await screen.findByRole('columnheader', { name: 'Q1 FY2026' });
    expect(q1).toHaveAttribute('title', 'Period ends 2025-09-30');
    expect(screen.getByRole('columnheader', { name: 'Q4 FY2026' })).toBeInTheDocument();
  });

  it('shows share counts with a shares unit and EPS per share, not as money', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/fundamentals/statements', () =>
        ok({
          symbol: 'AAPL',
          statement: 'income',
          period: 'annual',
          lineItems: [
            { key: 'revenue', label: 'Revenue' },
            { key: 'epsDiluted', label: 'EPS (diluted)' },
            { key: 'weightedAverageShsOutDil', label: 'Diluted shares outstanding' },
          ],
          rows: [
            {
              fiscalYear: 2025,
              fiscalPeriod: 'FY',
              periodEnd: '2025-09-27',
              filingDate: null,
              reportedCurrency: 'USD',
              lines: { revenue: 394_328_000_000, epsDiluted: 6.13, weightedAverageShsOutDil: 15_408_000_000 },
            },
          ],
        }),
      ),
    );
    drawer('AAPL');
    await user.click(screen.getByRole('tab', { name: 'Statements' }));
    await screen.findByTestId('reported-currency');
    const cell = (name: RegExp) => within(screen.getByRole('row', { name })).getAllByRole('cell')[0];
    expect(cell(/^Diluted shares/)).toHaveTextContent('15.41B shares');
    expect(cell(/^EPS/)).toHaveTextContent(/^6\.13$/);
    expect(cell(/^Revenue/)).toHaveTextContent(/^394\.33B$/);
  });

  it('switches statement kind', async () => {
    const user = userEvent.setup();
    drawer('AAPL');
    await user.click(screen.getByRole('tab', { name: 'Statements' }));
    await user.click(screen.getByRole('button', { name: 'Balance sheet' }));
    expect(await screen.findByRole('row', { name: /^Total assets/ })).toBeInTheDocument();
  });
});

describe('Trends tab', () => {
  it('draws the five inline-SVG charts and unmounts cleanly', async () => {
    const user = userEvent.setup();
    const { unmount } = drawer('AAPL');
    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    for (const t of ['Revenue', 'Net income', 'EPS (diluted)', 'Margins', 'Free cash flow']) {
      expect(await screen.findByTestId(`chart-${t}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('chart-Margins').querySelectorAll('path').length).toBe(3);
    unmount();
  });

  it('leaves out only the gross line for a lender (JPM), and says why', async () => {
    const user = userEvent.setup();
    drawer('JPM');
    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    const chart = await screen.findByTestId('chart-Margins');
    expect(chart.querySelector('svg')).not.toBeNull();
    expect(chart.querySelectorAll('path').length).toBe(2); // operating and net
    expect(chart).toHaveTextContent('Operating');
    expect(chart).not.toHaveTextContent('Gross');
    expect(screen.getByTestId('gross-margin-note')).toHaveTextContent(/interest expense/);
  });

  it('switches to quarterly periods', async () => {
    const user = userEvent.setup();
    drawer('MSFT');
    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    await screen.findByTestId('chart-Revenue');
    await user.click(screen.getByRole('button', { name: 'Quarterly' }));
    await waitFor(() => expect(screen.getByTestId('chart-Revenue')).toHaveTextContent('Q1 FY2025'));
  });
});

describe('Earnings tab', () => {
  it('shows an upcoming report as upcoming, with no actuals or surprise', async () => {
    const user = userEvent.setup();
    drawer('AAPL');
    await user.click(screen.getByRole('tab', { name: 'Earnings' }));
    const row = await screen.findByTestId('earnings-2026-10-29');
    expect(row).toHaveAttribute('data-outcome', 'upcoming');
    expect(row).toHaveTextContent('Upcoming');
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('—'); // EPS actual
    expect(cells[3]).toHaveTextContent('—'); // EPS surprise
  });

  it('shows beat, estimate and surprise percentage for a past report', async () => {
    const user = userEvent.setup();
    drawer('AAPL');
    await user.click(screen.getByRole('tab', { name: 'Earnings' }));
    const row = await screen.findByTestId('earnings-2026-07-30');
    expect(row).toHaveAttribute('data-outcome', 'beat');
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('1.46');
    expect(cells[2]).toHaveTextContent('1.36');
    expect(cells[3]).toHaveTextContent('+7.35%'); // (1.46 - 1.36) / 1.36
  });

  it('marks a miss', async () => {
    const e: EarningsResponse = {
      symbol: 'AAPL',
      events: [{ date: '2026-01-29', epsActual: 1, epsEstimate: 2, revenueActual: 90, revenueEstimate: 100 }],
    };
    server.use(http.get('*/api/fundamentals/earnings', () => ok(e)));
    render(<EarningsTab symbol="AAPL" />);
    const row = await screen.findByTestId('earnings-2026-01-29');
    expect(row).toHaveAttribute('data-outcome', 'miss');
    expect(row).toHaveTextContent('-50.00%');
    expect(row).toHaveTextContent('-10.00%');
  });
});

describe('useEarningsMarkers', () => {
  const events: EarningsResponse = {
    symbol: 'AAPL',
    events: [
      { date: '2026-10-29', epsActual: null, epsEstimate: 1.99, revenueActual: null, revenueEstimate: 1 },
      { date: '2026-07-30', epsActual: 2.02, epsEstimate: 1.89, revenueActual: 5, revenueEstimate: 4 }, // beat, EDT
      { date: '2026-01-29', epsActual: 1.0, epsEstimate: 2.0, revenueActual: 5, revenueEstimate: 4 }, // miss, EST
      { date: '2025-10-30', epsActual: 1.85, epsEstimate: 1.73, revenueActual: 5, revenueEstimate: 4 },
    ],
  };

  it('returns one E marker per past report at New York midnight, coloured by beat or miss', async () => {
    server.use(http.get('*/api/fundamentals/earnings', () => ok(events)));
    const { result } = renderHook(() => useEarningsMarkers('AAPL'));
    await waitFor(() => expect(result.current).toHaveLength(3));
    const byId = Object.fromEntries(result.current.map((m) => [m.id, m]));
    expect(result.current.every((m) => m.text === 'E')).toBe(true);
    // 2026-07-30 is in daylight time (UTC-4); 2026-01-29 is in standard time (UTC-5).
    expect(byId['earnings-AAPL-2026-07-30']?.time).toBe(Date.UTC(2026, 6, 30, 4) / 1000);
    expect(byId['earnings-AAPL-2026-01-29']?.time).toBe(Date.UTC(2026, 0, 29, 5) / 1000);
    expect(byId['earnings-AAPL-2026-07-30']?.color).toBe('#26a69a'); // --up
    expect(byId['earnings-AAPL-2026-01-29']?.color).toBe('#ef5350'); // --down
    expect(byId['earnings-AAPL-2026-10-29']).toBeUndefined(); // upcoming: no flag
    const times = result.current.map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('shares one request with the Earnings tab', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/fundamentals/earnings', () => {
        calls += 1;
        return ok(events);
      }),
    );
    function Both() {
      const markers = useEarningsMarkers('AAPL');
      return (
        <>
          <span data-testid="count">{markers.length}</span>
          <EarningsTab symbol="AAPL" />
        </>
      );
    }
    render(<Both />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'));
    await screen.findByTestId('earnings-2026-07-30');
    expect(calls).toBe(1);
  });

  it('makes no request and returns nothing when fundamentals are not served', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/capabilities', () => ok({ timeframes: ['1D'], delayed: true, provider: 'x', fundamentals: false })),
      http.get('*/api/fundamentals/earnings', () => {
        calls += 1;
        return ok(events);
      }),
    );
    const { result } = renderHook(() => useEarningsMarkers('AAPL'));
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(result.current).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('returns nothing, not stale markers, when the request fails', async () => {
    server.use(http.get('*/api/fundamentals/earnings', () => fail({ code: 'UPSTREAM_ERROR', message: 'x' })));
    const { result } = renderHook(() => useEarningsMarkers('AAPL'));
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(result.current).toHaveLength(0);
  });
});

describe('Earnings tab: Show more', () => {
  const openEarnings = async (symbol = 'AAPL') => {
    const user = userEvent.setup();
    const view = drawer(symbol);
    await user.click(screen.getByRole('tab', { name: 'Earnings' }));
    await screen.findByTestId('earnings-table');
    return { user, ...view };
  };
  const rows = () => within(screen.getByTestId('earnings-table')).getAllByRole('row').length - 1;

  it('shows 40 rows and a Show more button, then loads 40 more per click until all 165', async () => {
    const { user } = await openEarnings();
    expect(rows()).toBe(40);
    for (const expected of [80, 120, 160, 165]) {
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      await waitFor(() => expect(rows()).toBe(expected));
    }
    expect(screen.queryByRole('button', { name: /Show more|Loading/ })).toBeNull();
  });

  it('keeps the rows on screen while loading and disables the button', async () => {
    const { user } = await openEarnings();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get('*/api/fundamentals/earnings', async ({ request }) => {
        await gate;
        const limit = Number(new URL(request.url).searchParams.get('limit'));
        const events = Array.from({ length: limit }, (_, i) => ({
          date: `2000-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`,
          epsActual: 1,
          epsEstimate: 1,
          revenueActual: 1,
          revenueEstimate: 1,
        }));
        return ok({ symbol: 'AAPL', events });
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    const busy = screen.getByRole('button', { name: 'Loading…' });
    expect(busy).toBeDisabled();
    expect(rows()).toBe(40);
    release();
    await waitFor(() => expect(rows()).toBe(80));
  });

  it('does not change the request the markers use, and hides the button when a reply is short', async () => {
    const limits: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const u = new URL(request.url);
      if (u.pathname.endsWith('/fundamentals/earnings')) limits.push(u.searchParams.get('limit') ?? '');
    });
    try {
      function Both() {
        useEarningsMarkers('RIVN');
        return <EarningsTab symbol="RIVN" />;
      }
      render(<Both />);
      await screen.findByTestId('earnings-table');
      expect(limits).toEqual(['40']); // one shared initial request
      // RIVN has 28 events: fewer than the limit, so there is nothing more to show.
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    } finally {
      server.events.removeAllListeners();
    }
  });

  it('leaves the markers request count unchanged on Show more', async () => {
    const limits: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const u = new URL(request.url);
      if (u.pathname.endsWith('/fundamentals/earnings')) limits.push(u.searchParams.get('limit') ?? '');
    });
    try {
      function Both() {
        const markers = useEarningsMarkers('AAPL');
        return (
          <>
            <span data-testid="count">{markers.length}</span>
            <EarningsTab symbol="AAPL" />
          </>
        );
      }
      const user = userEvent.setup();
      render(<Both />);
      await screen.findByTestId('earnings-table');
      const before = screen.getByTestId('count').textContent;
      expect(limits).toEqual(['40']);
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      await waitFor(() => expect(limits).toEqual(['40', '80']));
      expect(screen.getByTestId('count').textContent).toBe(before);
    } finally {
      server.events.removeAllListeners();
    }
  });

  it('keeps the current rows and shows Retry when loading more fails', async () => {
    const { user } = await openEarnings();
    server.use(http.get('*/api/fundamentals/earnings', () => fail({ code: 'UPSTREAM_ERROR', message: 'x' })));
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more reports');
    expect(rows()).toBe(40);
    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rows()).toBe(80));
  });

  it('resets to 40 rows when the symbol changes', async () => {
    const user = userEvent.setup();
    const view = renderWithDataSource(<EarningsTab symbol="AAPL" />);
    await screen.findByTestId('earnings-table');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(rows()).toBe(80));
    view.rerender(<EarningsTab symbol="MSFT" />);
    await waitFor(() => expect(screen.getByTestId('earnings-2026-10-28')).toBeInTheDocument());
    expect(rows()).toBe(40);
    view.rerender(<EarningsTab symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('earnings-2026-10-29')).toBeInTheDocument());
    expect(rows()).toBe(40);
  });
});

describe('News tab', () => {
  const openNews = async (symbol: string) => {
    drawer(symbol);
    await userEvent.click(screen.getByRole('tab', { name: 'News' }));
  };
  const article = (i: number, url: string | null = `https://example.com/${i}`): NewsArticle => ({
    publishedAt: 1_790_000_000 - i * 3600,
    title: `Story ${i}`,
    summary: null,
    publisher: 'Example Wire',
    site: 'example.com',
    url,
  });
  const serveNews = (patch: Partial<NewsResponse>) =>
    server.use(http.get('*/api/fundamentals/news', () => ok({ ...newsFor('AAPL'), ...patch })));

  it('lists the articles newest first under New York date headings, and states the window', async () => {
    await openNews('AAPL');
    const list = await screen.findByTestId('news-list');
    expect(list).toHaveTextContent('8 articles from 2026-08-02 to 2026-10-02. Times are New York time (ET).');
    const days = within(list).getAllByRole('heading', { level: 3 });
    expect(days[0]).toHaveTextContent('Fri, Oct 2, 2026');
    expect(days).toHaveLength(7);
    const items = within(list).getAllByTestId('news-item');
    expect(items[0]).toHaveTextContent('Apple supplier orders rise ahead of the holiday quarter');
    // 15:42:10 in New York, shown in New York time whatever the zone of the test machine.
    expect(items[0]).toHaveTextContent('3:42 PM');
    expect(items[0]).toHaveTextContent('Example Wire');
  });

  it('opens a link in a new tab with no opener and no referrer', async () => {
    await openNews('AAPL');
    const link = await screen.findByRole('link', { name: 'Apple supplier orders rise ahead of the holiday quarter' });
    expect(link).toHaveAttribute('href', 'https://www.example.com/news/aapl/0');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows a title with no link as plain text', async () => {
    serveNews({ articles: [article(1, null)] });
    await openNews('AAPL');
    expect(await screen.findByText('Story 1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Story 1' })).toBeNull();
  });

  it('says so when the symbol has no news in the window (RIVN)', async () => {
    await openNews('RIVN');
    expect(await screen.findByText('No news from 2026-08-02 to 2026-10-02.')).toBeInTheDocument();
  });

  it('shows 50 articles, then 50 more per Show more, until all are shown', async () => {
    serveNews({ articles: Array.from({ length: 120 }, (_, i) => article(i)) });
    await openNews('AAPL');
    await screen.findByTestId('news-list');
    expect(screen.getAllByTestId('news-item')).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 120.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('news-item')).toHaveLength(100);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('news-item')).toHaveLength(120);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says when only the newest articles are shown', async () => {
    serveNews({ articles: [article(1)], truncated: true });
    await openNews('AAPL');
    expect(await screen.findByTestId('news-list')).toHaveTextContent('Only the newest 2000 articles are shown.');
  });

  it('shows an error with retry for a server failure', async () => {
    server.use(http.get('*/api/fundamentals/news', () => fail({ code: 'UPSTREAM_ERROR', message: 'x' })));
    await openNews('AAPL');
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('full page', () => {
  const page = (onClose = vi.fn()) => {
    renderWithDataSource(<FundamentalsDrawer symbol="AAPL" onClose={onClose} />);
    return onClose;
  };

  it('moves focus into the page when it opens, so Esc works at once', () => {
    page();
    expect(screen.getByTestId('fundamentals-drawer')).toHaveFocus();
  });

  it('closes with the Back to chart button', async () => {
    const onClose = page();
    await userEvent.click(screen.getByRole('button', { name: 'Back to chart' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Esc while focus is inside the page', async () => {
    const onClose = page();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on an Esc that a control inside the page already used', () => {
    const onClose = page();
    const tab = screen.getByRole('tab', { name: 'Trends' });
    tab.addEventListener('keydown', (e) => e.preventDefault()); // e.g. an open list closing first
    act(() => {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('names the page after the symbol and shows it as a heading', () => {
    page();
    expect(screen.getByRole('region', { name: 'Financials for AAPL' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Financials\s*AAPL/ })).toBeInTheDocument();
  });
});
