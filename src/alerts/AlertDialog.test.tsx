import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { Alert, AlertCondition } from '@shared/types';
import { mockAlerts, resetMockAlerts } from '../../mocks/alerts';
import { InMemoryWorkspaceProvider } from '../workspace';
import { AlertDialog } from './AlertDialog';
import { AlertsProvider, useAlerts } from './AlertsProvider';
import type { AlertDraft } from './AlertsProvider';
import { fakeEventSources } from './testing/fakeEventSource';

beforeEach(() => resetMockAlerts());

function Open({ draft }: { draft: AlertDraft }) {
  const { openDialog, status } = useAlerts();
  useEffect(() => {
    if (status === 'ready') openDialog(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  return null;
}

function renderDialog(draft: AlertDraft) {
  render(
    <InMemoryWorkspaceProvider>
      <AlertsProvider eventSource={fakeEventSources().factory} notify={() => undefined}>
        <Open draft={draft} />
        <AlertDialog />
      </AlertsProvider>
    </InMemoryWorkspaceProvider>,
  );
}

const macd: AlertCondition = {
  type: 'indicator',
  timeframe: '1D',
  indicator: { kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  line: 'macd',
  direction: 'cross',
  target: { type: 'value', value: 0.5 },
};

describe('AlertDialog', () => {
  it('a new price alert has the defaults: crossing, once, 1 month, the price at the point', async () => {
    renderDialog({ symbol: 'AAPL', condition: { type: 'price', direction: 'cross', level: 187.25 } });
    const dialog = await screen.findByRole('dialog', { name: /Create alert/ });
    expect(dialog).toHaveTextContent('AAPL');
    expect(screen.getByLabelText('Condition')).toHaveValue('cross');
    expect(screen.getByLabelText('Price')).toHaveValue(187.25);
    expect(screen.getByLabelText('Once')).toBeChecked();
    expect(screen.getByLabelText('Expires in')).toHaveValue('1M');
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', 'AAPL crossing 187.25');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockAlerts().alerts[0]).toMatchObject({
      symbol: 'AAPL',
      condition: { type: 'price', direction: 'cross', level: 187.25 },
      frequency: 'once',
      expiry: '1M',
      message: '',
    });
  });

  it('the user changes direction, trigger, expiry and message', async () => {
    renderDialog({ symbol: 'MSFT', condition: { type: 'price', direction: 'cross', level: 400 } });
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'down' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '395.5' } });
    fireEvent.click(screen.getByLabelText('Every time'));
    fireEvent.change(screen.getByLabelText('Expires in'), { target: { value: '3y' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'sell?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockAlerts().alerts).toHaveLength(1));
    expect(mockAlerts().alerts[0]).toMatchObject({ condition: { direction: 'down', level: 395.5 }, frequency: 'every', expiry: '3y', message: 'sell?' });
  });

  it('an edit of the message only keeps the expiry time and the side', async () => {
    const stored: Alert = {
      id: 'a1', symbol: 'AAPL', condition: { type: 'price', direction: 'cross', level: 190 }, frequency: 'once', expiry: '1M',
      expiresAt: 1_800_000_000, message: 'old', status: 'active', revision: 3, createdAt: 1_790_000_000, updatedAt: 1_790_000_000,
      state: { lastSide: 'below', lastCheckedAt: 1, lastDayHigh: 189, lastDayLow: 180, lastBarTime: null, firedCount: 0, lastFiredAt: null },
    };
    resetMockAlerts({ alerts: [stored] });
    renderDialog({ id: 'a1', revision: 3, symbol: 'AAPL', condition: stored.condition, frequency: 'once', expiry: '1M', message: 'old' });
    await screen.findByRole('dialog', { name: /Edit alert/ });
    expect(screen.getByLabelText('Price')).toHaveValue(190);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockAlerts().alerts[0]?.message).toBe('new'));
    expect(mockAlerts().alerts[0]).toMatchObject({ expiresAt: 1_800_000_000, state: { lastSide: 'below', lastDayHigh: 189 }, revision: 4 });
  });

  it('a sub-cent level keeps its digits', async () => {
    renderDialog({ symbol: 'PENNY', condition: { type: 'price', direction: 'cross', level: 0.004123 } });
    await screen.findByRole('dialog');
    expect(screen.getByLabelText('Price')).toHaveValue(0.004123);
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', 'PENNY crossing 0.004123');
  });

  it('an empty or zero price disables Create', async () => {
    renderDialog({ symbol: 'MSFT', condition: { type: 'price', direction: 'cross', level: 400 } });
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('an indicator alert: line, target line, and the copy of the indicator', async () => {
    renderDialog({ symbol: 'NVDA', condition: macd });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('MACD (12, 26, 9)');
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'line' } });
    // Two other lines (signal, histogram): a second select picks one. Signal is first.
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockAlerts().alerts).toHaveLength(1));
    expect(mockAlerts().alerts[0]?.condition).toEqual({ ...macd, target: { type: 'line', line: 'signal' } });
  });

  it('Esc and Cancel close without a change', async () => {
    renderDialog({ symbol: 'AAPL', condition: { type: 'price', direction: 'cross', level: 1 } });
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockAlerts().alerts).toEqual([]);
  });

  it('a server error shows a message and keeps the dialog open', async () => {
    renderDialog({ symbol: 'A B', condition: { type: 'price', direction: 'cross', level: 1 } });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/The alert was not saved/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
