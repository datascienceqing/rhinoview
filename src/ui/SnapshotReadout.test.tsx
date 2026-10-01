import { screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { Snapshot } from '@shared/types';
import { server } from '../../mocks/server';
import { DataError } from '../data';
import { SnapshotReadout } from './SnapshotReadout';
import { fakeDataSource, renderWithDataSource } from './testUtils';

const snapshot = (over: Partial<Snapshot>): Snapshot => ({
  symbol: 'AAPL', price: 100, change: 1.23, changePercent: 0.0123, previousClose: 98.77,
  dayOpen: null, dayHigh: null, dayLow: null, dayVolume: null, updated: null, delayed: false, ...over,
});

describe('SnapshotReadout', () => {
  it('shows price, absolute change and percent change, treating changePercent as a fraction', async () => {
    renderWithDataSource(
      <SnapshotReadout symbol="AAPL" name="Apple Inc." />,
      fakeDataSource({ getSnapshot: () => Promise.resolve(snapshot({})) }),
    );
    expect(await screen.findByTestId('snapshot-price')).toHaveTextContent('100.00');
    expect(screen.getByTestId('snapshot-change')).toHaveTextContent('+1.23');
    expect(screen.getByTestId('snapshot-change-percent')).toHaveTextContent('+1.23%');
    expect(screen.getByTestId('snapshot-change')).toHaveClass('up');
  });

  it('shows negative change in the down colour', async () => {
    renderWithDataSource(
      <SnapshotReadout symbol="AAPL" name={null} />,
      fakeDataSource({ getSnapshot: () => Promise.resolve(snapshot({ change: -2, changePercent: -0.02 })) }),
    );
    expect(await screen.findByTestId('snapshot-change-percent')).toHaveTextContent('-2.00%');
    expect(screen.getByTestId('snapshot-change-percent')).toHaveClass('down');
  });

  it('badges delayed data visibly', async () => {
    renderWithDataSource(<SnapshotReadout symbol="AAPL" name={null} />); // fixture: delayed:true
    expect(await screen.findByTestId('delayed-badge')).toHaveTextContent('DELAYED');
  });

  it('shows no badge when the data is not delayed', async () => {
    server.use(
      http.get('*/api/snapshot', () => HttpResponse.json({ ok: true, data: snapshot({ delayed: false }) })),
    );
    renderWithDataSource(<SnapshotReadout symbol="AAPL" name={null} />);
    await screen.findByTestId('snapshot-price');
    expect(screen.queryByTestId('delayed-badge')).not.toBeInTheDocument();
  });

  it('renders null prices as dashes, never zeros', async () => {
    renderWithDataSource(
      <SnapshotReadout symbol="AAPL" name={null} />,
      fakeDataSource({ getSnapshot: () => Promise.resolve(snapshot({ price: null, change: null, changePercent: null })) }),
    );
    expect(await screen.findByTestId('snapshot-price')).toHaveTextContent('—');
    expect(screen.getByTestId('snapshot-change-percent')).toHaveTextContent('—');
  });

  it("shows a loading state, never the previous symbol's quote under a new symbol", async () => {
    function Harness() {
      const [symbol, setSymbol] = useState('AAPL');
      return (
        <>
          <button onClick={() => setSymbol('MSFT')}>switch</button>
          <SnapshotReadout symbol={symbol} name={null} />
        </>
      );
    }
    renderWithDataSource(
      <Harness />,
      fakeDataSource({
        getSnapshot: (symbol) =>
          symbol === 'AAPL' ? Promise.resolve(snapshot({ price: 111 })) : new Promise(() => {}),
      }),
    );
    expect(await screen.findByTestId('snapshot-price')).toHaveTextContent('111.00');
    await userEvent.setup().click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.queryByTestId('snapshot-price')).not.toBeInTheDocument();
    expect(screen.getByText('Loading quote…')).toBeInTheDocument();
  });

  it.each([
    ['UNKNOWN_SYMBOL', /symbol not found/i, false],
    ['RATE_LIMITED', /too many requests/i, true],
    ['UPSTREAM_ERROR', /data provider error/i, true],
    ['NETWORK', /connection lost/i, true],
  ] as const)('shows an inline error for %s without hiding the symbol', async (code, copy, retryable) => {
    renderWithDataSource(
      <SnapshotReadout symbol="XYZ" name="Some Co" />,
      fakeDataSource({ getSnapshot: () => Promise.reject(new DataError(code, 'raw')) }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    expect(screen.getByText('XYZ')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' }) !== null).toBe(retryable);
  });

  it('retries after an error', async () => {
    const getSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new DataError('UPSTREAM_ERROR', 'x'))
      .mockResolvedValueOnce(snapshot({ price: 55 }));
    renderWithDataSource(<SnapshotReadout symbol="AAPL" name={null} />, fakeDataSource({ getSnapshot }));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('snapshot-price')).toHaveTextContent('55.00');
  });
});
