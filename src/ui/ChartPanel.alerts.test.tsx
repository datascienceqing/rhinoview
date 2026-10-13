/**
 * The chart menu's add-alert items inside the chart panel: the price, the visible SMA and EMA
 * lines on the price pane (target: the close), and an indicator pane (target: the value).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ConfluenceParams, IndicatorConfig } from '@shared/types';
import { DEFAULT_PARAMS } from '../indicators/types';
import { resetMockAlerts } from '../../mocks/alerts';
import { AlertDialog, AlertsProvider } from '../alerts';
import { fakeEventSources } from '../alerts/testing/fakeEventSource';
import { lastChart, resetFakeCharts } from '../chart/testing/fakeLightweightCharts';
import type { FakePane } from '../chart/testing/fakeLightweightCharts';
import { DEFAULT_ACTIVE_CHART, InMemoryWorkspaceProvider } from '../workspace';
import { ChartPanel } from './ChartPanel';
import { renderWithDataSource } from './testUtils';

vi.mock('lightweight-charts', async () => (await import('../chart/testing/fakeLightweightCharts')).fakeModule);

beforeEach(() => {
  resetFakeCharts();
  resetMockAlerts();
  localStorage.clear();
});

const sma: IndicatorConfig = { id: 'sma1', kind: 'sma', params: { period: 50, source: 'close' }, color: '#f00', visible: true };
const ema: IndicatorConfig = { id: 'ema1', kind: 'ema', params: { period: 20, source: 'close' }, color: '#0f0', visible: true };
const hiddenEma: IndicatorConfig = { ...ema, id: 'ema2', params: { period: 9, source: 'close' }, visible: false };
const rsi: IndicatorConfig = { id: 'rsi1', kind: 'rsi', params: { period: 14 }, color: '#00f', visible: true };
// A latch date before the first bar: the latch is active from bar 0 and locks at the first primary.
const latched: ConfluenceParams = { ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: 1 };
const conf: IndicatorConfig = { id: 'conf1', kind: 'confluence', params: latched, color: '#fa0', visible: true };

async function renderPanel(indicators: IndicatorConfig[]) {
  renderWithDataSource(
    <InMemoryWorkspaceProvider initial={{ ...DEFAULT_ACTIVE_CHART, symbol: 'AAPL', timeframe: '1D', indicators }}>
      <AlertsProvider eventSource={fakeEventSources().factory} notify={() => undefined}>
        <ChartPanel symbol="AAPL" timeframe="1D" chartType="candlestick" />
        <AlertDialog />
      </AlertsProvider>
    </InMemoryWorkspaceProvider>,
  );
  await screen.findByTestId('crosshair-legend');
  // Rows are 300 px high from y = 0, 860 px wide (800 plot + 60 scale).
  lastChart().paneList.forEach((p: FakePane, i: number) => {
    p.element.getBoundingClientRect = () => ({ left: 0, top: i * 300, right: 860, bottom: (i + 1) * 300, width: 860, height: 300, x: 0, y: i * 300, toJSON: () => ({}) });
  });
}

const rightClick = (x: number, y: number) =>
  fireEvent.contextMenu(screen.getByTestId('chart-container'), { clientX: x, clientY: y, bubbles: true, cancelable: true });
const alertItems = () => screen.getAllByRole('menuitem').map((b) => b.textContent).filter((t) => t?.startsWith('Add alert'));

describe('chart menu: alert items', () => {
  it('on the price pane: the price, then each visible SMA and EMA', async () => {
    await renderPanel([sma, hiddenEma, ema, rsi]);
    rightClick(100, 120);
    expect(alertItems()).toEqual(['Add alert at 440.00…', 'Add alert on SMA (50)…', 'Add alert on EMA (20)…']);
  });

  it('an SMA item opens an indicator alert on the close, with no Close option for other kinds', async () => {
    await renderPanel([sma]);
    rightClick(100, 120);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add alert on SMA (50)…' }));
    const dialog = await screen.findByRole('dialog', { name: /Create alert/ });
    expect(dialog).toHaveTextContent('SMA (50)');
    expect(screen.getByLabelText('Target')).toHaveValue('close');
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', expect.stringContaining('SMA (50)'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('on an RSI pane: the RSI item, and its dialog offers no close target', async () => {
    await renderPanel([rsi]);
    rightClick(100, 420);
    const items = alertItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^Add alert on RSI \(14\) at /);
    fireEvent.click(screen.getAllByRole('menuitem')[0] as HTMLElement);
    await screen.findByRole('dialog', { name: /Create alert/ });
    const targets = [...(screen.getByLabelText('Target') as HTMLSelectElement).options].map((o) => o.value);
    expect(targets).toEqual(['value']);
  });
});

describe('chart menu: confluence alert', () => {
  it('a latched confluence has an item at its locked level, and the dialog shows the fixed level and the latch date', async () => {
    await renderPanel([conf]);
    rightClick(100, 120);
    const item = alertItems().find((t) => t?.startsWith('Add alert on CONF Turn (250) at the latched '));
    expect(item).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
    const dialog = await screen.findByRole('dialog', { name: /Create alert/ });
    expect(dialog).toHaveTextContent('CONF Turn (250)');
    expect(dialog).toHaveTextContent(/Close above \d+\.\d{2} \(\d+ levels\)/);
    expect(dialog).toHaveTextContent('Latch date');
    expect(screen.queryByLabelText('Target')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', expect.stringMatching(/^AAPL CONF Turn \(250\) closing above .+ \(latched .+\)$/));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('no item when the latch is off or the indicator is hidden', async () => {
    await renderPanel([
      { ...conf, params: { ...latched, latch: 'off' } },
      { ...conf, id: 'conf2', visible: false },
    ]);
    rightClick(100, 120);
    expect(alertItems().filter((t) => t?.includes('CONF'))).toEqual([]);
  });
});
