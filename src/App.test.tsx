import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetFakeCharts, lastChart } from './chart/testing/fakeLightweightCharts';
import { server } from '../mocks/server';
import { resetMockWorkspace } from '../mocks/workspace';
import { App } from './App';

vi.mock('lightweight-charts', async () => (await import('./chart/testing/fakeLightweightCharts')).fakeModule);

beforeEach(() => {
  resetFakeCharts();
  // The workspace provider writes to the shared mock; start every test from the default workspace.
  resetMockWorkspace();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

/** Records every /api/bars request's timeframe, in order. */
function recordBarsTimeframes(): string[] {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/bars') seen.push(url.searchParams.get('timeframe') ?? '');
  });
  return seen;
}
afterEach(() => server.events.removeAllListeners());

async function selectSymbol(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.clear(screen.getByRole('combobox', { name: 'Search symbol' }));
  await user.type(screen.getByRole('combobox', { name: 'Search symbol' }), query);
  // Scope to the toolbar search: the watchlist panel also renders <option> elements.
  const results = await screen.findByRole('listbox', { name: 'Search symbol results' }, { timeout: 2000 });
  await within(results).findAllByRole('option');
  await user.keyboard('{Enter}');
}

describe('App', () => {
  it('loads AAPL 1D on start: header quote with the synthetic badge (mock data), and a chart with bars', async () => {
    render(<App />);
    expect(await screen.findByTestId('snapshot-price')).toHaveTextContent('220.23');
    expect(screen.getByTestId('snapshot-change-percent')).toHaveTextContent('+0.67%');
    expect(await screen.findByTestId('synthetic-badge')).toHaveTextContent('SYNTHETIC');
    expect(await screen.findByTestId('crosshair-legend')).toBeInTheDocument();
    expect(lastChart().liveSeries).toHaveLength(1);
  });

  it('lists all six timeframes from the contract and marks 1D active', async () => {
    render(<App />);
    const group = screen.getByRole('group', { name: 'Timeframe' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['1m', '5m', '15m', '1h', '1D', '1W']);
    expect(within(group).getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByTestId('crosshair-legend');
  });

  it('refetches bars for the new timeframe when a timeframe is clicked', async () => {
    const seen = recordBarsTimeframes();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    expect(seen).toContain('1D');
    expect(seen).not.toContain('5m');

    await userEvent.setup().click(screen.getByRole('button', { name: '5m' }));
    await waitFor(() => expect(seen).toContain('5m'));
    expect(await screen.findByText('AAPL · 5m')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches chart type without recreating the chart', async () => {
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    const chart = lastChart();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Line' }));
    expect(chart.liveSeries.map((s) => (s.definition as { tag: string }).tag)).toEqual(['Line']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Bars' }));
    expect(chart.liveSeries.map((s) => (s.definition as { tag: string }).tag)).toEqual(['Bar']);
  });

  it('searching and picking an unknown symbol shows symbol-not-found in the chart and the quote', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    // AAPL.MX is a real search result, but the mock proxy only has data for AAPL.
    await selectSymbol(user, 'aapl.mx');
    expect(await screen.findByText('Symbol not found')).toBeInTheDocument();
    expect(await screen.findByText(/Quote unavailable: symbol not found/)).toBeInTheDocument();
  });

  it('picking the rate-limited symbol shows rate-limit copy for chart and quote', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    await selectSymbol(user, 'limit');
    expect(await screen.findByText(/Try again in 12 seconds/)).toBeInTheDocument();
    expect(await screen.findByText(/Quote unavailable: too many requests/)).toBeInTheDocument();
  });

  it('shows search copy for zero results', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('combobox', { name: 'Search symbol' }), 'zzzzzz');
    expect(await screen.findByText(/No symbols match “zzzzzz”/, undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('shows search copy when the search is rate limited', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('combobox', { name: 'Search symbol' }), 'throttle');
    expect(await screen.findByText(/rate limiting us/, undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('lazy-loads older history when the chart is scrolled to its left edge', async () => {
    const seen = recordBarsTimeframes();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    const before = seen.length;
    act(() => lastChart().scrollTo({ from: -10, to: 90 }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(before));
  });
});

describe('Financials page', () => {
  it('opens over the chart, closes on Esc, and returns focus to the Financials button', async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = await screen.findByRole('button', { name: 'Financials' }, { timeout: 3000 });
    await user.click(toggle);
    const page = await screen.findByRole('region', { name: /Financials for / });
    expect(page).toHaveFocus();
    // The chart stays mounted underneath, so it keeps its position when the page closes.
    expect(screen.getByTestId('chart-container')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: /Financials for / })).toBeNull();
    expect(toggle).toHaveFocus();
  });
});
