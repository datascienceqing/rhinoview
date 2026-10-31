import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import type { ReactElement } from 'react';
import type { IndicatorConfig } from '@shared/types';
import { DataSourceProvider, HttpDataSource } from '../data';
import { charts, lastChart, resetFakeCharts } from '../chart/testing/fakeLightweightCharts';
import type { FakeChart, FakeSeries } from '../chart/testing/fakeLightweightCharts';
import { DEFAULT_ACTIVE_CHART, InMemoryWorkspaceProvider, WorkspaceProvider, useActiveChart } from '../workspace';
import { resetMockWorkspace, mockWorkspace } from '../../mocks/workspace';
import { DEFAULT_PARAMS } from '../indicators/types';
import { ChartPanel } from './ChartPanel';
import type { ChartPanelProps } from './ChartPanel';
import { renderWithDataSource } from './testUtils';
import { DrawingsPrimitive } from '../drawings/DrawingsPrimitive';

vi.mock('lightweight-charts', async () => (await import('../chart/testing/fakeLightweightCharts')).fakeModule);

/** ChartPanel reads indicators from the active chart, so it needs a workspace provider. */
function inMemory(ui: ReactElement, initial?: IndicatorConfig[]) {
  return initial ? (
    <InMemoryWorkspaceProvider initial={{ ...DEFAULT_ACTIVE_CHART, indicators: initial }}>
      {ui}
    </InMemoryWorkspaceProvider>
  ) : (
    <InMemoryWorkspaceProvider>{ui}</InMemoryWorkspaceProvider>
  );
}

beforeEach(() => {
  resetMockWorkspace();
  resetFakeCharts();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const props: ChartPanelProps = {
  symbol: 'AAPL',
  timeframe: '1D',
  chartType: 'candlestick',
};

async function renderPanel(p: Partial<ChartPanelProps> = {}) {
  const view = renderWithDataSource(inMemory(<ChartPanel {...props} {...p} />));
  await screen.findByTestId('crosshair-legend');
  return view;
}

const tag = (s: FakeSeries) => (s.definition as { tag: string }).tag;
const paneTags = (chart: FakeChart) => chart.paneContents.map((p) => p.map(tag));
const lastData = (s: FakeSeries) => s.setData.mock.calls.at(-1)?.[0] as { time: number; value?: number }[];

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: /^Indicators/ });
  if (button.getAttribute('aria-expanded') !== 'true') await user.click(button);
}
async function add(user: ReturnType<typeof userEvent.setup>, kind: 'SMA' | 'EMA' | 'RSI' | 'MACD' | 'Liquidity') {
  await openMenu(user);
  await user.click(screen.getByRole('button', { name: `Add ${kind}` }));
}

describe('adding and removing indicators', () => {
  it('creates a pane for RSI and another for MACD, and removes each when the indicator is removed', async () => {
    const user = userEvent.setup();
    await renderPanel();
    const chart = lastChart();
    expect(chart.paneList).toHaveLength(1);

    await add(user, 'RSI');
    expect(paneTags(chart)).toEqual([['Candlestick'], ['Line']]);
    await add(user, 'MACD');
    expect(paneTags(chart)).toEqual([['Candlestick'], ['Line'], ['Line', 'Line', 'Histogram']]);

    await user.click(screen.getByRole('button', { name: 'Remove RSI (14)' }));
    expect(paneTags(chart)).toEqual([['Candlestick'], ['Line', 'Line', 'Histogram']]);
    await user.click(screen.getByRole('button', { name: 'Remove MACD (12, 26, 9)' }));
    expect(paneTags(chart)).toEqual([['Candlestick']]);
    expect(chart.liveSeries).toHaveLength(1);
  });

  it('draws SMA and EMA on the price pane', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'SMA');
    await add(user, 'EMA');
    expect(paneTags(lastChart())).toEqual([['Candlestick', 'Line', 'Line']]);
  });

  it('lets two SMAs of different periods coexist, each with its own legend row', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'SMA');
    await add(user, 'SMA');
    const periods = screen.getAllByLabelText('Period', {
      selector: 'input[type="number"]',
    });
    expect(periods).toHaveLength(2);
    const second = periods[1];
    if (!second) throw new Error('missing second editor');
    fireEvent.change(second, { target: { value: '50' } });

    const chart = lastChart();
    expect(chart.paneContents[0]).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Remove SMA (20)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove SMA (50)' })).toBeInTheDocument();
    const rows = screen.getAllByTestId(/^indicator-legend-/);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('SMA (20)'),
      expect.stringContaining('SMA (50)'),
    ]);
  });

  it('toggles visibility and colour through series options, without rewriting data', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    const rsi = lastChart().paneContents[1]?.[0];
    rsi?.setData.mockClear();
    await user.click(screen.getByRole('checkbox', { name: 'Show RSI (14)' }));
    expect(rsi?.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    fireEvent.change(screen.getByLabelText('Colour of RSI (14)'), {
      target: { value: '#123456' },
    });
    expect(rsi?.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#123456' }));
    expect(rsi?.setData).not.toHaveBeenCalled();
  });
});

describe('parameter editor', () => {
  it('rejects an out-of-range period with a visible reason and does not apply or coerce it', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    const rsi = lastChart().paneContents[1]?.[0];
    rsi?.setData.mockClear();
    const input = screen.getByLabelText('Period', {
      selector: 'input[type="number"]',
    });

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 500/);
    expect(input).toHaveValue(0); // shown as typed, not silently corrected
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: '501' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 500/);
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/);
    expect(rsi?.setData).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove RSI (14)' })).toBeInTheDocument(); // still the last valid params
  });

  it('applies the next valid value and clears the error', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    const input = screen.getByLabelText('Period', {
      selector: 'input[type="number"]',
    });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '9' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove RSI (9)' })).toBeInTheDocument();
  });

  it('rejects MACD fast >= slow on both fields, applies nothing, and recovers when fixed', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'MACD');
    const [macd, signal] = lastChart().paneContents[1] ?? [];
    macd?.setData.mockClear();
    signal?.setData.mockClear();
    const fast = screen.getByLabelText('Fast', {
      selector: 'input[type="number"]',
    });
    const slow = screen.getByLabelText('Slow', {
      selector: 'input[type="number"]',
    });

    fireEvent.change(fast, { target: { value: '30' } });
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual([
      expect.stringMatching(/Fast period must be less than slow/),
      expect.stringMatching(/Slow period must be greater than fast/),
    ]);
    expect(macd?.setData).not.toHaveBeenCalled();

    fireEvent.change(slow, { target: { value: '40' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove MACD (30, 40, 9)' })).toBeInTheDocument();
    expect(macd?.setData).toHaveBeenCalledTimes(1);
  });

  it('offers a Source choice for moving averages only (RSI shares their { period } shape but has no source)', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    expect(screen.queryByLabelText('Source')).toBeNull();
    await add(user, 'EMA');
    expect(screen.getAllByLabelText('Source')).toHaveLength(1);
  });

  it('adds Liquidity from the menu as a drawing on the price pane, with its Zone and Sweeps selects', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'Liquidity');
    expect(screen.getByRole('button', { name: 'Remove LIQ (10)' })).toBeInTheDocument();
    expect(lastChart().paneList).toHaveLength(1);
    // The drawing tools keep their own primitive on the price series too.
    expect(lastChart().paneContents[0]?.[0]?.primitives.filter((p) => !(p instanceof DrawingsPrimitive))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'range' } });
    fireEvent.change(screen.getByLabelText('Pivot lookback', { selector: 'input[type="number"]' }), { target: { value: '5' } });
    expect(screen.getByRole('button', { name: 'Remove LIQ (5)' })).toBeInTheDocument();
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('range');
  });

  it('keeps the MACD sliders inside the valid ordering so they cannot produce fast >= slow', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'MACD');
    expect(screen.getByLabelText('Fast slider')).toHaveAttribute('max', '25');
    expect(screen.getByLabelText('Slow slider')).toHaveAttribute('min', '13');
    expect(screen.getByLabelText('Signal slider')).toHaveAttribute('max', '500');
  });

  it('moves the indicator live as a slider is dragged, without rebuilding the chart', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'SMA');
    await add(user, 'RSI');
    const chart = lastChart();
    const [, sma] = chart.paneContents[0] ?? [];
    const rsi = chart.paneContents[1]?.[0];
    sma?.setData.mockClear();
    rsi?.setData.mockClear();
    const sliders = screen.getAllByLabelText('Period slider');
    for (const v of ['21', '22', '23', '30']) fireEvent.change(sliders[0] as HTMLElement, { target: { value: v } });

    expect(sma?.setData).toHaveBeenCalledTimes(4);
    expect(rsi?.setData).not.toHaveBeenCalled(); // only the affected series
    expect(charts).toHaveLength(1);
    expect(chart.series.filter((s) => s.removed)).toHaveLength(0);
    // SMA(30): 29 whitespace points, then values.
    expect(lastData(sma as FakeSeries).findIndex((d) => d.value !== undefined)).toBe(29);
  });
});

describe('per-pane crosshair legend', () => {
  it('shows the indicator value at the crosshair and falls back to the latest bar on leave', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    await add(user, 'SMA');
    const chart = lastChart();
    const rsi = chart.paneContents[1]?.[0] as FakeSeries;
    const sma = chart.paneContents[0]?.[1] as FakeSeries;
    const data = lastData(rsi);
    const rsiId = screen
      .getAllByTestId(/^indicator-legend-/)
      .find((e) => e.textContent?.includes('RSI'))
      ?.dataset['testid']?.replace('indicator-legend-', '');
    if (!rsiId) throw new Error('no RSI legend');
    const rsiText = () => screen.getByTestId(`indicator-value-${rsiId}-value`).textContent;

    // Latest bar by default.
    expect(rsiText()).toBe(data.at(-1)?.value?.toFixed(2));

    const k = data.length - 30;
    const hovered = data[k];
    if (hovered?.value === undefined) throw new Error('fixture: RSI undefined at hover bar');
    act(() => chart.hover(hovered.time));
    await waitFor(() => expect(rsiText()).toBe(hovered.value?.toFixed(2)));
    // The price-pane SMA legend follows the same crosshair.
    const smaHover = lastData(sma)[k];
    const smaRow = screen.getAllByTestId(/^indicator-legend-/).find((e) => e.textContent?.includes('SMA'));
    expect(smaRow).toHaveTextContent(smaHover?.value?.toFixed(2) ?? 'NaN');

    act(() => chart.hover(undefined));
    await waitFor(() => expect(rsiText()).toBe(data.at(-1)?.value?.toFixed(2)));
  });

  it('shows a dash for MACD lines at a warmup bar, never 0', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'MACD');
    const chart = lastChart();
    const first = lastData(chart.paneContents[1]?.[0] as FakeSeries)[2];
    if (!first) throw new Error('no bars');
    act(() => chart.hover(first.time));
    const row = screen.getAllByTestId(/^indicator-legend-/)[0];
    if (!row) throw new Error('no legend');
    await waitFor(() => expect(within(row).getAllByText('—')).toHaveLength(3));
  });
});

describe('recompute on bars change', () => {
  it('rewrites indicator data when the timeframe (and so the bars) change', async () => {
    const user = userEvent.setup();
    const ds = new HttpDataSource();
    const ui = (p: ChartPanelProps) => (
      <DataSourceProvider value={ds}>{inMemory(<ChartPanel {...p} />)}</DataSourceProvider>
    );
    const { rerender } = render(ui(props));
    await screen.findByTestId('crosshair-legend');
    await add(user, 'RSI');
    const rsi = lastChart().paneContents[1]?.[0] as FakeSeries;
    const dailyTimes = lastData(rsi).map((d) => d.time);
    rsi.setData.mockClear();

    rerender(ui({ ...props, timeframe: '1W' }));
    await waitFor(() => expect(rsi.setData).toHaveBeenCalled());
    await waitFor(() => expect(lastData(rsi).map((d) => d.time)).not.toEqual(dailyTimes));
    // Indicator times track the new bars exactly; the pane itself was not rebuilt.
    const candles = lastChart().paneContents[0]?.[0] as FakeSeries;
    expect(lastData(rsi).map((d) => d.time)).toEqual(lastData(candles).map((d) => d.time));
    expect(charts).toHaveLength(1);
    expect(lastChart().paneList).toHaveLength(2);
  });
});

/** The app's own wiring: the chart's props come from the active layout. */
function Connected() {
  const { chart } = useActiveChart();
  return <ChartPanel symbol={chart.symbol} timeframe={chart.timeframe} chartType={chart.chartType} />;
}
const connected = (ds = new HttpDataSource()) => (
  <DataSourceProvider value={ds}>
    <WorkspaceProvider>
      <Connected />
    </WorkspaceProvider>
  </DataSourceProvider>
);

describe('indicators belong to the layout', () => {
  it('keeps the indicators when the symbol changes', async () => {
    const user = userEvent.setup();
    const ds = new HttpDataSource();
    const ui = (symbol: string) => (
      <DataSourceProvider value={ds}>{inMemory(<ChartPanel {...props} symbol={symbol} />)}</DataSourceProvider>
    );
    const { rerender } = render(ui('AAPL'));
    await screen.findByTestId('crosshair-legend');
    await add(user, 'RSI');
    expect(lastChart().paneList).toHaveLength(2);

    rerender(ui('MSFT'));
    // The mock proxy has bars for AAPL only; the new symbol's own state does not matter here.
    await screen.findByText('Symbol not found');
    expect(lastChart().paneList).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove RSI (14)' })).toBeInTheDocument();
  });

  it('saves them in the layout on the server and restores them, with edited params and colours, after a remount', async () => {
    const user = userEvent.setup();
    const first = render(connected());
    await screen.findByTestId('crosshair-legend');
    await add(user, 'RSI');
    fireEvent.change(screen.getByLabelText('Period', { selector: 'input[type="number"]' }), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Colour of RSI (7)'), {
      target: { value: '#abcdef' },
    });
    await waitFor(() => expect(mockWorkspace().layouts[0]?.indicators).toHaveLength(1), { timeout: 3000 });
    expect(mockWorkspace().layouts[0]?.indicators[0]).toMatchObject({
      kind: 'rsi',
      params: { period: 7 },
      color: '#abcdef',
    });
    first.unmount();

    resetFakeCharts();
    render(connected());
    await screen.findByTestId('crosshair-legend');
    expect(paneTags(lastChart())).toEqual([['Candlestick'], ['Line']]);
    expect(lastChart().paneContents[1]?.[0]?.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#abcdef' }),
    );
    await openMenu(user);
    expect(screen.getByRole('button', { name: 'Remove RSI (7)' })).toBeInTheDocument();
  });

  it('renders the chart, and still lets indicators be added, when storage throws on every access', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await renderPanel();
    expect(lastChart().liveSeries).toHaveLength(1);
    await add(user, 'RSI');
    expect(lastChart().paneList).toHaveLength(2);
  });

  it('no longer writes indicators to localStorage', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'EMA');
    expect(localStorage.length).toBe(0);
  });
});

describe('disposal under StrictMode', () => {
  it('leaves exactly one live chart whose indicator series are all live, and removes everything on unmount', async () => {
    const seeded: IndicatorConfig[] = [
      {
        id: 'r',
        kind: 'rsi',
        params: { period: 14 },
        color: '#2962ff',
        visible: true,
      },
      {
        id: 'm',
        kind: 'macd',
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        color: '#e91e63',
        visible: true,
      },
      {
        id: 's',
        kind: 'sma',
        params: { period: 20, source: 'close' },
        color: '#00bcd4',
        visible: true,
      },
    ];
    const { unmount } = render(
      <StrictMode>
        <DataSourceProvider value={new HttpDataSource()}>
          {inMemory(<ChartPanel {...props} />, seeded)}
        </DataSourceProvider>
      </StrictMode>,
    );
    await screen.findByTestId('crosshair-legend');
    const live = charts.filter((c) => !c.removed);
    expect(charts.length).toBeGreaterThanOrEqual(2);
    expect(live).toHaveLength(1);
    const chart = live[0] as FakeChart;
    expect(paneTags(chart)).toEqual([['Candlestick', 'Line'], ['Line'], ['Line', 'Line', 'Histogram']]);
    // Nothing on a removed chart was ever left drawing into the live one.
    expect(chart.series.every((s) => s.removed || chart.liveSeries.includes(s))).toBe(true);

    unmount();
    expect(charts.every((c) => c.removed)).toBe(true);
  });
});

describe('indicator order', () => {
  const rsiTags = ['Line'];
  const macdTags = ['Line', 'Line', 'Histogram'];
  const listTitles = () => screen.getAllByTestId(/^indicator-item-/).map((li) => li.querySelector('.indicator-item-title')?.textContent);

  it('moves a pane up with the ▲ button: the list and the panes take the new order', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    await add(user, 'MACD');
    const chart = lastChart();
    expect(paneTags(chart)).toEqual([['Candlestick'], rsiTags, macdTags]);
    await user.click(screen.getByRole('button', { name: 'Move MACD (12, 26, 9) up' }));
    expect(paneTags(chart)).toEqual([['Candlestick'], macdTags, rsiTags]);
    expect(listTitles()).toEqual(['MACD (12, 26, 9)', 'RSI (14)']);
    // At the top ▲ is disabled, so the focus stays on the moved row, on its grip.
    expect(screen.getByRole('button', { name: 'Move MACD (12, 26, 9) up' })).toBeDisabled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder MACD (12, 26, 9)' }));
  });

  it('moves a row with Alt+ArrowDown and Alt+ArrowUp on its grip, and keeps the focus there', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    await add(user, 'MACD');
    const grip = screen.getByRole('button', { name: 'Reorder RSI (14)' });
    grip.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(listTitles()).toEqual(['MACD (12, 26, 9)', 'RSI (14)']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder RSI (14)' }));
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}'); // already last: nothing moves
    expect(listTitles()).toEqual(['MACD (12, 26, 9)', 'RSI (14)']);
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(listTitles()).toEqual(['RSI (14)', 'MACD (12, 26, 9)']);
    expect(paneTags(lastChart())).toEqual([['Candlestick'], rsiTags, macdTags]);
  });

  it('moves a row by drag and drop on its grip', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    await add(user, 'MACD');
    await add(user, 'SMA');
    const row = (title: string) => screen.getByRole('button', { name: `Reorder ${title}` }).closest('li') as HTMLElement;
    fireEvent.dragStart(screen.getByRole('button', { name: 'Reorder SMA (20)' }));
    fireEvent.dragOver(row('RSI (14)'));
    expect(row('RSI (14)')).toHaveClass('drop');
    fireEvent.drop(row('RSI (14)'));
    expect(listTitles()).toEqual(['SMA (20)', 'RSI (14)', 'MACD (12, 26, 9)']);
    expect(row('RSI (14)')).not.toHaveClass('drop');
    // SMA is an overlay: the panes keep RSI above MACD.
    expect(paneTags(lastChart())).toEqual([['Candlestick', 'Line'], rsiTags, macdTags]);
  });

  it('orders the legend rows of overlays as the list', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'SMA');
    await add(user, 'EMA');
    await user.click(screen.getByRole('button', { name: 'Move EMA (20) up' }));
    const rows = screen.getAllByTestId(/^indicator-legend-/);
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('EMA (20)'), expect.stringContaining('SMA (20)')]);
  });

  it('shows no order controls for a single indicator, and disables ▼ on the last row', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await add(user, 'RSI');
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    await add(user, 'MACD');
    expect(screen.getByRole('button', { name: 'Move MACD (12, 26, 9) down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move RSI (14) up' })).toBeDisabled();
    expect(screen.getByText(/to change the order/)).toBeInTheDocument();
  });

  it('saves the order in the layout on the server and restores it after a remount', async () => {
    const user = userEvent.setup();
    const first = render(connected());
    await screen.findByTestId('crosshair-legend');
    await add(user, 'RSI');
    await add(user, 'MACD');
    await user.click(screen.getByRole('button', { name: 'Move MACD (12, 26, 9) up' }));
    await waitFor(() => expect(mockWorkspace().layouts[0]?.indicators.map((i) => i.kind)).toEqual(['macd', 'rsi']), { timeout: 3000 });
    first.unmount();

    resetFakeCharts();
    render(connected());
    await screen.findByTestId('crosshair-legend');
    expect(paneTags(lastChart())).toEqual([['Candlestick'], macdTags, rsiTags]);
  });
});

describe('confluence latch handle', () => {
  const confluence = (latch: 'on' | 'off', latchTime = 0): IndicatorConfig => ({
    id: 'cf',
    kind: 'confluence',
    params: { ...DEFAULT_PARAMS.confluence, latch, latchTime },
    color: '#00bcd4',
    visible: true,
  });

  it('shows the handle for a confluence indicator with the latch on, and gives a new latch a date at once', async () => {
    renderWithDataSource(inMemory(<ChartPanel {...props} />, [confluence('on')]));
    await screen.findByTestId('crosshair-legend');
    const tab = await screen.findByRole('button', { name: /^Latch date / });
    // The handle saved the centre bar of the view: the date is a 2025 or 2026 bar, not 1 January 1970.
    await waitFor(() => expect(tab.getAttribute('aria-label')).not.toMatch(/Jan 1\./));
    expect(tab.closest('.latch-handle')).toHaveClass('latch-turn');
  });

  it('shows no handle while the latch is off', async () => {
    renderWithDataSource(inMemory(<ChartPanel {...props} />, [confluence('off', 1_780_000_000)]));
    await screen.findByTestId('crosshair-legend');
    expect(screen.queryByRole('button', { name: /^Latch date / })).toBeNull();
  });
});
