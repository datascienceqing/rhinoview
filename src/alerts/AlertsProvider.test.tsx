import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Alert, AlertEvent } from '@shared/types';
import { mockAlerts, mockFireAlert, resetMockAlerts } from '../../mocks/alerts';
import { InMemoryWorkspaceProvider, useActiveChart } from '../workspace';
import { AlertBell } from './AlertBell';
import { AlertToasts, MAX_TOASTS } from './AlertToasts';
import { AlertsProvider, TOAST_MS, useAlerts } from './AlertsProvider';
import { AlertsWindow } from './AlertsWindow';
import { resetChimeForTests } from './chime';
import { fakeEventSources } from './testing/fakeEventSource';

let sources: ReturnType<typeof fakeEventSources>;
let notified: string[];

beforeEach(() => {
  resetMockAlerts();
  resetChimeForTests();
  sources = fakeEventSources();
  notified = [];
});

function Probe() {
  const { chart } = useActiveChart();
  const { unchecked, status } = useAlerts();
  return (
    <div data-testid="probe">
      {chart.symbol}|{chart.timeframe}|{unchecked}|{status}
    </div>
  );
}

function Harness({ children }: { children?: ReactNode }) {
  return (
    <InMemoryWorkspaceProvider>
      <AlertsProvider eventSource={sources.factory} notify={(title, body) => notified.push(`${title}: ${body}`)}>
        <AlertBell />
        <AlertToasts />
        <AlertsWindow />
        <Probe />
        {children}
      </AlertsProvider>
    </InMemoryWorkspaceProvider>
  );
}

const probe = () => screen.getByTestId('probe').textContent;

/** Create an alert in the mock (as another tab would) and fire it there. */
async function fireInMock(symbol = 'MSFT', level = 400): Promise<{ alert: Alert; event: AlertEvent }> {
  const res = await fetch('http://localhost/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, condition: { type: 'price', direction: 'cross', level }, frequency: 'every' }),
  });
  const alert = ((await res.json()) as { data: Alert }).data;
  const event = mockFireAlert(alert.id, level + 1, level);
  const after = mockAlerts().alerts.find((a) => a.id === alert.id) as Alert;
  return { alert: after, event };
}

async function renderReady() {
  render(<Harness />);
  await waitFor(() => expect(probe()).toMatch(/\|ready$/));
}

describe('AlertsProvider: stream', () => {
  it('a fired message shows a popup, counts on the bell, and notifies', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    expect(screen.getByRole('alert', { name: 'Alert: MSFT' })).toHaveTextContent('MSFT crossing 400.00');
    expect(screen.getByRole('button', { name: 'Alerts: 1 new' })).toBeInTheDocument();
    expect(notified).toEqual(['MSFT: MSFT crossing 400.00']);
  });

  it('the same event twice counts once', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => {
      sources.last().emit({ type: 'fired', event, alert });
      sources.last().emit({ type: 'fired', event, alert });
    });
    expect(screen.getAllByRole('alert', { name: 'Alert: MSFT' })).toHaveLength(1);
    expect(probe()).toContain('|1|');
  });

  it('after a lost connection it loads the events it missed', async () => {
    await renderReady();
    act(() => sources.last().open());
    await fireInMock('NVDA', 100); // fired while the stream was down: no message came
    expect(probe()).toContain('|0|');
    act(() => sources.last().reopen());
    await waitFor(() => expect(probe()).toContain('|1|'));
  });

  it('a checked message from another tab sets the count', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    expect(probe()).toContain('|1|');
    act(() => sources.last().emit({ type: 'checked', unchecked: 0 }));
    expect(probe()).toContain('|0|');
  });

  it('a checked message with ids marks those events here, with no load of the log', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    // The mock still has the event unchecked: a load of the log would show it as new again.
    act(() => sources.last().emit({ type: 'checked', unchecked: 0, checkedIds: [event.id] }));
    act(() => screen.getByRole('button', { name: 'Alerts' }).click());
    await new Promise((r) => setTimeout(r, 50));
    const row = within(screen.getByRole('dialog', { name: 'Alerts' })).getByRole('listitem');
    expect(row).toHaveClass('checked');
    expect(probe()).toContain('|0|');
  });

  it('a checked message with a deleted id removes that event here', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    act(() => sources.last().emit({ type: 'checked', unchecked: 0, deletedId: event.id }));
    act(() => screen.getByRole('button', { name: 'Alerts' }).click());
    expect(within(screen.getByRole('dialog', { name: 'Alerts' })).queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('an event that fires while the log loads stays in the list and in the count', async () => {
    await renderReady();
    act(() => sources.last().open());
    const { alert } = await fireInMock('NVDA', 100);
    // Only the stream knows this event; the load that starts now does not have it.
    const streamed: AlertEvent = { ...mockAlerts().events[0]!, id: 'only-on-stream', firedAt: 2_000_000_000 };
    act(() => {
      sources.last().reopen();
      sources.last().emit({ type: 'fired', event: streamed, alert });
    });
    await waitFor(() => expect(probe()).toContain('|2|'));
    await new Promise((r) => setTimeout(r, 50));
    expect(probe()).toContain('|2|');
  });

  it('a budget message shows a warning that the user can dismiss', async () => {
    await renderReady();
    act(() => sources.last().emit({ type: 'budget', budgetPerMinute: 150, waitingSymbols: 12 }));
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('The alert checker used all 150 data calls of this minute. 12 symbols wait');
    fireEvent.click(within(note).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('closes the stream on unmount', async () => {
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(probe()).toMatch(/\|ready$/));
    unmount();
    expect(sources.last().closed).toBe(true);
  });
});

describe('AlertsProvider: popups', () => {
  afterEach(() => vi.useRealTimers());

  it('a popup shrinks into the bell after 30 s and its event stays unchecked', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    vi.useFakeTimers();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    expect(screen.getByRole('alert', { name: 'Alert: MSFT' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.queryByRole('alert', { name: 'Alert: MSFT' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert', { name: 'Alert: MSFT' })).not.toBeInTheDocument();
    vi.useRealTimers();
    expect(probe()).toContain('|1|');
    expect(mockAlerts().events[0]?.checked).toBe(false);
  });

  it('Dismiss closes the popup and marks its event as checked on the server', async () => {
    await renderReady();
    const { alert, event } = await fireInMock();
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    const toast = screen.getByRole('alert', { name: 'Alert: MSFT' });
    fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert', { name: 'Alert: MSFT' })).not.toBeInTheDocument();
    await waitFor(() => expect(mockAlerts().events[0]?.checked).toBe(true));
    await waitFor(() => expect(probe()).toContain('|0|'));
  });

  it('Show on chart shows the symbol', async () => {
    await renderReady();
    const { alert, event } = await fireInMock('TSLA', 250);
    act(() => sources.last().emit({ type: 'fired', event, alert }));
    fireEvent.click(screen.getByRole('button', { name: 'Show on chart' }));
    expect(probe()).toMatch(/^TSLA\|/);
  });

  it(`shows at most ${MAX_TOASTS} popups and one "more" line`, async () => {
    await renderReady();
    for (let i = 0; i < MAX_TOASTS + 2; i++) {
      const { alert, event } = await fireInMock(`S${i}`, 10 + i);
      act(() => sources.last().emit({ type: 'fired', event, alert }));
    }
    expect(screen.getAllByRole('alert', { name: /^Alert: / })).toHaveLength(MAX_TOASTS);
    expect(screen.getByText('2 more alerts')).toBeInTheDocument();
  });
});
