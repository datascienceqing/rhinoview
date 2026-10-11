import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Alert, AlertEvent, CreateAlertBody } from '@shared/types';
import { mockAlerts, mockFireAlert, resetMockAlerts } from '../../mocks/alerts';
import { I18nProvider } from '../i18n';
import { LOCALE_KEY } from '../i18n/locale';
import { InMemoryWorkspaceProvider, useActiveChart } from '../workspace';
import { AlertBell } from './AlertBell';
import { AlertDialog } from './AlertDialog';
import { AlertsProvider, useAlerts } from './AlertsProvider';
import { AlertsWindow } from './AlertsWindow';
import { fakeEventSources } from './testing/fakeEventSource';
import { clampToBounds } from './useFloatingWindow';

// jsdom has no PointerEvent; a MouseEvent with a pointer id is enough for the drag code.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent ??= TestPointerEvent;
});

let sources: ReturnType<typeof fakeEventSources>;
beforeEach(() => {
  resetMockAlerts();
  sources = fakeEventSources();
});

function Probe() {
  const { chart } = useActiveChart();
  const { unchecked } = useAlerts();
  return (
    <div data-testid="probe">
      {chart.symbol}|{chart.timeframe}|{unchecked}
    </div>
  );
}

const probe = () => screen.getByTestId('probe').textContent;

async function post(body: CreateAlertBody): Promise<Alert> {
  const res = await fetch('http://localhost/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return ((await res.json()) as { data: Alert }).data;
}

const rsi: CreateAlertBody = {
  symbol: 'NVDA',
  condition: { type: 'indicator', timeframe: '1h', indicator: { kind: 'rsi', params: { period: 14 } }, line: 'value', direction: 'up', target: { type: 'value', value: 70 } },
};

/** Two alerts (AAPL price, NVDA RSI) and one fired event of each. */
async function seed(): Promise<{ events: AlertEvent[] }> {
  const a = await post({ symbol: 'AAPL', condition: { type: 'price', direction: 'cross', level: 190 }, frequency: 'every' });
  const b = await post({ ...rsi, frequency: 'every' });
  const e1 = mockFireAlert(a.id, 191, 190);
  const e2 = mockFireAlert(b.id, 71, 70);
  return { events: [e2, e1] };
}

async function renderApp() {
  render(
    <I18nProvider>
      <InMemoryWorkspaceProvider>
        <AlertsProvider eventSource={sources.factory} notify={() => undefined}>
          <AlertBell />
          <AlertsWindow />
          <AlertDialog />
          <Probe />
        </AlertsProvider>
      </InMemoryWorkspaceProvider>
    </I18nProvider>,
  );
  await waitFor(() => expect(probe()).toMatch(/\|2$/));
}

const windowEl = () => screen.getByRole('dialog', { name: 'Alerts' });
const openFromBell = () => fireEvent.click(screen.getByRole('button', { name: /^Alerts/ }));

describe('Alerts window: dock, float, minimize', () => {
  it('the bell opens the window docked, on the Triggered tab', async () => {
    await seed();
    await renderApp();
    openFromBell();
    expect(windowEl()).toHaveClass('docked');
    expect(within(windowEl()).getByRole('tab', { name: /Triggered/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('a drag of the title bar floats it; minimize and open again docks it', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const win = windowEl();
    win.getBoundingClientRect = () => ({ left: 600, top: 50, width: 360, height: 400, right: 960, bottom: 450, x: 600, y: 50, toJSON: () => ({}) });
    const bar = win.querySelector('.alerts-window-bar') as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 610, clientY: 60 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 410, clientY: 160 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 410, clientY: 160 });
    expect(win).toHaveClass('floating');
    expect(win.style.left).toBe('400px');
    expect(win.style.top).toBe('150px');

    fireEvent.click(within(win).getByRole('button', { name: 'Minimize' }));
    expect(screen.queryByRole('dialog', { name: 'Alerts' })).not.toBeInTheDocument();
    openFromBell();
    expect(windowEl()).toHaveClass('docked');
  });

  it('a drag cannot take the window outside the app window', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const win = windowEl();
    win.getBoundingClientRect = () => ({ left: 600, top: 50, width: 360, height: 400, right: 960, bottom: 450, x: 600, y: 50, toJSON: () => ({}) });
    const bar = win.querySelector('.alerts-window-bar') as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 610, clientY: 60 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: -500, clientY: 5000 });
    expect(win.style.left).toBe('0px');
    expect(win.style.top).toBe(`${window.innerHeight - 400}px`);
  });

  it('Esc minimizes; the Dock button docks a floating window', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const win = windowEl();
    win.getBoundingClientRect = () => ({ left: 600, top: 50, width: 360, height: 400, right: 960, bottom: 450, x: 600, y: 50, toJSON: () => ({}) });
    const bar = win.querySelector('.alerts-window-bar') as HTMLElement;
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(win).toHaveClass('floating');
    fireEvent.click(within(win).getByRole('button', { name: 'Dock' }));
    expect(win).toHaveClass('docked');
    fireEvent.keyDown(win, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Alerts' })).not.toBeInTheDocument();
  });
});

describe('clampToBounds', () => {
  it('keeps the box inside', () => {
    expect(clampToBounds({ x: -10, y: -10 }, { width: 100, height: 50 }, { width: 500, height: 300 })).toEqual({ x: 0, y: 0 });
    expect(clampToBounds({ x: 450, y: 280 }, { width: 100, height: 50 }, { width: 500, height: 300 })).toEqual({ x: 400, y: 250 });
    expect(clampToBounds({ x: 10, y: 10 }, { width: 900, height: 50 }, { width: 500, height: 300 })).toEqual({ x: 0, y: 10 });
  });
});

describe('Alerts window: rows and actions', () => {
  it('shows unchecked events first with their own look, and a click shows the symbol and timeframe', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const rows = within(windowEl()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('unchecked');
    fireEvent.click(within(rows[0] as HTMLElement).getByText('NVDA'));
    expect(probe()).toMatch(/^NVDA\|1h\|/);
    await waitFor(() => expect(probe()).toMatch(/\|1$/));
    expect(mockAlerts().events.find((e) => e.symbol === 'NVDA')?.checked).toBe(true);
  });

  it('Mark all as checked sets the count to 0 and keeps the events', async () => {
    await seed();
    await renderApp();
    openFromBell();
    fireEvent.click(within(windowEl()).getByRole('button', { name: 'Mark all as checked' }));
    await waitFor(() => expect(probe()).toMatch(/\|0$/));
    expect(mockAlerts().events.every((e) => e.checked)).toBe(true);
    expect(within(windowEl()).getAllByRole('listitem')).toHaveLength(2);
    expect(within(windowEl()).getByRole('button', { name: 'Mark all as checked' })).toBeDisabled();
  });

  it('search filters by symbol and by indicator', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const search = within(windowEl()).getByRole('searchbox', { name: 'Search symbol or indicator' });
    fireEvent.change(search, { target: { value: 'aapl' } });
    expect(within(windowEl()).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'RSI' } });
    expect(within(windowEl()).getAllByRole('listitem')[0]).toHaveTextContent('NVDA');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(within(windowEl()).getByText('Nothing matches the search.')).toBeInTheDocument();
  });

  it('search works in the Chinese interface too', async () => {
    await seed();
    localStorage.setItem(LOCALE_KEY, 'zh');
    await renderApp();
    localStorage.removeItem(LOCALE_KEY);
    fireEvent.click(screen.getByRole('button', { name: /^警报/ }));
    const win = screen.getByRole('dialog', { name: '警报' });
    fireEvent.change(within(win).getByRole('searchbox', { name: '搜索代码或指标' }), { target: { value: 'rsi' } });
    expect(within(win).getAllByRole('listitem')).toHaveLength(1);
  });

  it('the Alerts tab: pause, enable, delete, and edit', async () => {
    await seed();
    await renderApp();
    openFromBell();
    fireEvent.click(within(windowEl()).getByRole('tab', { name: /^Alerts/ }));
    const row = () => within(windowEl()).getByText('AAPL').closest('li') as HTMLElement;
    fireEvent.click(within(row()).getByRole('button', { name: 'Pause AAPL' }));
    await waitFor(() => expect(row()).toHaveClass('status-paused'));
    fireEvent.click(within(row()).getByRole('button', { name: 'Enable AAPL' }));
    await waitFor(() => expect(row()).toHaveClass('status-active'));

    fireEvent.click(within(row()).getByRole('button', { name: 'Edit AAPL' }));
    expect(screen.getByRole('dialog', { name: /Edit alert/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(row()).getByRole('button', { name: 'Delete AAPL' }));
    await waitFor(() => expect(within(windowEl()).queryByText('AAPL')).not.toBeInTheDocument());
    expect(mockAlerts().alerts.map((a) => a.symbol)).toEqual(['NVDA']);
  });

  it('deletes an event from the log', async () => {
    await seed();
    await renderApp();
    openFromBell();
    const row = within(windowEl()).getByText('AAPL').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete AAPL' }));
    await waitFor(() => expect(within(windowEl()).getAllByRole('listitem')).toHaveLength(1));
    await waitFor(() => expect(probe()).toMatch(/\|1$/));
  });

  it('a checked message from another tab updates the rows', async () => {
    await seed();
    await renderApp();
    openFromBell();
    await act(async () => {
      await fetch('http://localhost/api/alerts/events/checked', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    });
    act(() => sources.last().emit({ type: 'checked', unchecked: 0 }));
    await waitFor(() => expect(within(windowEl()).getAllByRole('listitem').every((li) => li.classList.contains('checked'))).toBe(true));
    expect(probe()).toMatch(/\|0$/);
  });
});
