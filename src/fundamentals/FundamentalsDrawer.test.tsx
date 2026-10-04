import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EarningsResponse, FundamentalsOverview } from '@shared/types';
import { fail, ok } from '../../mocks/envelope';
import { overviewFor } from '../../mocks/fundamentalsData';
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

  it('shows margins as NM for a financial-sector issuer (JPM) but keeps returns', async () => {
    drawer('JPM');
    for (const k of ['grossMargin', 'operatingMargin', 'netMargin']) expect(await metric(k)).toHaveTextContent('NM');
    expect(await metric('returnOnEquity')).toHaveTextContent('%');
    expect(await metric('peRatio')).toHaveTextContent('14.29x');
  });

  it('shows fractions as percentages (AAPL gross margin)', async () => {
    drawer('AAPL');
    expect(await metric('grossMargin')).toHaveTextContent('48.65%');
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

  it('shows margins as NM for a financial-sector issuer (JPM)', async () => {
    const user = userEvent.setup();
    drawer('JPM');
    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    expect(await screen.findByTestId('chart-Margins')).toHaveTextContent('NM');
    expect(screen.getByTestId('chart-Margins').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('chart-Revenue').querySelector('svg')).not.toBeNull();
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
    expect(cells[1]).toHaveTextContent('2.02');
    expect(cells[2]).toHaveTextContent('1.89');
    expect(cells[3]).toHaveTextContent('+6.88%'); // (2.02 - 1.89) / 1.89
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
