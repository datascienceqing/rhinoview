import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { MOCK_SYMBOLS, sliceBars } from '../../mocks/data';
import { MAX_UNIX_SECONDS, parseBarsQuery } from '../../mocks/handlers';
import { ok } from '../../mocks/envelope';
import { server } from '../../mocks/server';
import { resetCapabilitiesCache } from '../data';
import { lastChart, resetFakeCharts } from '../chart/testing/fakeLightweightCharts';
import { ChartPanel } from './ChartPanel';
import { InMemoryWorkspaceProvider } from '../workspace';
import { renderWithDataSource as renderWithData } from './testUtils';

vi.mock('lightweight-charts', async () => (await import('../chart/testing/fakeLightweightCharts')).fakeModule);

/** ChartPanel reads indicators from the active chart, so it needs a workspace provider. */
function renderWithDataSource(ui: ReactElement) {
  return renderWithData(<InMemoryWorkspaceProvider>{ui}</InMemoryWorkspaceProvider>);
}

// Computed per test, under the faked clock (mock bars are generated relative to "now").
const allDaily = () => sliceBars('1D', 0, MAX_UNIX_SECONDS);

beforeEach(() => {
  resetFakeCharts();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  resetCapabilitiesCache(); // a test may have cached non-default capabilities
});

function value(testId: string) {
  return within(screen.getByTestId('crosshair-legend')).getByTestId(testId);
}

describe('ChartPanel crosshair legend', () => {
  it('shows O/H/L/C/V of the most recent bar until the crosshair is on the chart', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />);
    const last = allDaily().at(-1);
    if (!last) throw new Error('fixture empty');
    await screen.findByTestId('crosshair-legend');
    expect(value('legend-open')).toHaveTextContent(last.open.toFixed(2));
    expect(value('legend-high')).toHaveTextContent(last.high.toFixed(2));
    expect(value('legend-low')).toHaveTextContent(last.low.toFixed(2));
    expect(value('legend-close')).toHaveTextContent(last.close.toFixed(2));
    expect(value('legend-volume')).not.toHaveTextContent('—');
  });

  it('follows the crosshair to the hovered bar, and falls back to the latest bar on leave', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />);
    await screen.findByTestId('crosshair-legend');
    const hovered = allDaily().at(-20);
    const last = allDaily().at(-1);
    if (!hovered || !last) throw new Error('fixture too short');

    act(() => lastChart().hover(hovered.time));
    await waitFor(() => expect(value('legend-close')).toHaveTextContent(hovered.close.toFixed(2)));
    expect(value('legend-open')).toHaveTextContent(hovered.open.toFixed(2));
    expect(value('legend-high')).toHaveTextContent(hovered.high.toFixed(2));
    expect(value('legend-low')).toHaveTextContent(hovered.low.toFixed(2));

    act(() => lastChart().hover(undefined));
    await waitFor(() => expect(value('legend-close')).toHaveTextContent(last.close.toFixed(2)));
  });

  it('colours the change with the up/down classes that map to --up/--down', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />);
    await screen.findByTestId('crosshair-legend');
    const prev = allDaily().at(-2);
    const last = allDaily().at(-1);
    if (!prev || !last) throw new Error('fixture too short');
    expect(screen.getByTestId('crosshair-legend')).toHaveClass(last.close >= prev.close ? 'up' : 'down');
  });
});

describe('ChartPanel timeframe fallback', () => {
  it('draws the nearest supported timeframe when the saved one is not served, and fetches that one', async () => {
    resetCapabilitiesCache();
    server.use(
      http.get('*/api/capabilities', () =>
        ok({ timeframes: ['5m', '15m', '1h', '1D', '1W'], delayed: true, provider: 'test', fundamentals: true }),
      ),
    );
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/bars') seen.push(url.searchParams.get('timeframe') ?? '');
    });
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1m" chartType="candlestick" />);
    expect(await screen.findByText('AAPL · 5m')).toBeInTheDocument();
    expect(seen.at(-1)).toBe('5m');
    server.events.removeAllListeners();
  });
});

describe('ChartPanel states', () => {
  it('shows loading, then hides it once bars arrive', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="line" />);
    expect(screen.getByText('Loading AAPL 1D…')).toBeInTheDocument();
    await screen.findByTestId('crosshair-legend');
    expect(screen.queryByText('Loading AAPL 1D…')).not.toBeInTheDocument();
  });

  it('explains an empty result instead of showing a blank chart', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1m" chartType="candlestick" />);
    expect(await screen.findByText('No 1m data for AAPL')).toBeInTheDocument();
    expect(screen.queryByTestId('crosshair-legend')).not.toBeInTheDocument();
  });

  it('unknown symbol: says so, and offers no pointless retry', async () => {
    renderWithDataSource(<ChartPanel symbol="NOPE" timeframe="1D" chartType="candlestick" />);
    expect(await screen.findByText('Symbol not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('rate limited: shows the wait from retryAfterSeconds and a working retry', async () => {
    renderWithDataSource(<ChartPanel symbol={MOCK_SYMBOLS.rateLimited} timeframe="1D" chartType="candlestick" />);
    expect(await screen.findByText(/Try again in 12 seconds/)).toBeInTheDocument();

    server.use(
      http.get('*/api/bars', () =>
        HttpResponse.json({
          ok: true,
          data: {
            symbol: 'LIMIT',
            timeframe: '1D',
            adjusted: true,
            bars: allDaily(),
            truncated: false,
            cached: false,
          },
        }),
      ),
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('crosshair-legend')).toBeInTheDocument();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('upstream error: provider copy with retry', async () => {
    renderWithDataSource(<ChartPanel symbol={MOCK_SYMBOLS.upstreamError} timeframe="1D" chartType="candlestick" />);
    expect(await screen.findByText('Data provider error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('network loss: connection copy with retry', async () => {
    renderWithDataSource(<ChartPanel symbol={MOCK_SYMBOLS.networkDown} timeframe="1D" chartType="candlestick" />);
    expect(await screen.findByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says truncation means more history (not a gap), and clears once a complete response arrives', async () => {
    let call = 0;
    server.use(
      http.get('*/api/bars', ({ request }) => {
        const query = parseBarsQuery(request);
        if (!query.ok) return query.response;
        const bars = sliceBars(query.timeframe, query.from, query.to);
        return HttpResponse.json({
          ok: true,
          data: {
            symbol: 'AAPL',
            timeframe: query.timeframe,
            adjusted: true,
            bars,
            truncated: call++ === 0,
            cached: false,
          },
        });
      }),
    );
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />);
    const chip = await screen.findByText(/More history available/);
    expect(chip).toHaveAttribute('title', expect.stringMatching(/no gap/i));
    expect(screen.queryByText(/gap\./)).not.toBeInTheDocument();

    act(() => lastChart().scrollTo({ from: -5, to: 95 }));
    await waitFor(() => expect(screen.queryByText(/More history available/)).not.toBeInTheDocument());
  });

  it('failure to load older history keeps the chart and shows a retryable notice', async () => {
    renderWithDataSource(<ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />);
    await screen.findByTestId('crosshair-legend');
    server.use(
      http.get('*/api/bars', () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 3 },
          },
          { status: 429 },
        ),
      ),
    );
    act(() => lastChart().scrollTo({ from: -5, to: 95 }));
    expect(await screen.findByText(/couldn’t load older history/)).toBeInTheDocument();
    expect(screen.getByTestId('crosshair-legend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
