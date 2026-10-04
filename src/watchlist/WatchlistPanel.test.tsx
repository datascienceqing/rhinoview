import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Watchlist, Workspace } from '@shared/types';
import { DataSourceProvider, HttpDataSource, apiRequest } from '../data';
import { mockWorkspace, resetMockWorkspace } from '../../mocks/workspace';
import { mockSnapshot, resetMockQuotes, setMockQuotesDelayed } from '../../mocks/quotes';
import { ActiveChartContext } from '../workspace/ActiveChartContext';
import { DEFAULT_ACTIVE_CHART } from '../workspace';
import type { ActiveChartApi } from '../workspace';
import { WatchlistPanel } from './WatchlistPanel';

const DEFAULT = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'];
const ds = new HttpDataSource();

function chartApi(symbol = 'AAPL') {
  const setSymbol = vi.fn();
  const api: ActiveChartApi = {
    chart: { ...DEFAULT_ACTIVE_CHART, symbol },
    setSymbol,
    setTimeframe: vi.fn(),
    setChartType: vi.fn(),
    setIndicators: vi.fn(),
  };
  return { api, setSymbol };
}

function renderPanel(symbol?: string) {
  const { api, setSymbol } = chartApi(symbol);
  const wrap = (children: ReactNode) => (
    <DataSourceProvider value={ds}>
      <ActiveChartContext.Provider value={api}>{children}</ActiveChartContext.Provider>
    </DataSourceProvider>
  );
  render(wrap(<WatchlistPanel />));
  return { setSymbol };
}

const wlWith = (symbols: string[]): Workspace => {
  const ws = mockWorkspace();
  const w = ws.watchlists[0] as Watchlist;
  return { ...ws, watchlists: [{ ...w, symbols }] };
};

/** Symbols in table order, read from the row buttons. */
const order = () => screen.getAllByRole('button').filter((b) => b.classList.contains('wl-symbol')).map((b) => b.textContent);
const savedSymbols = () => mockWorkspace().watchlists[0]?.symbols;
const savedRevision = () => mockWorkspace().watchlists[0]?.revision;
const rowOf = (symbol: string) => screen.getByRole('button', { name: symbol }).closest('tr') as HTMLElement;
const byPrice = (symbols: string[], dir: 1 | -1) =>
  [...symbols].sort((a, b) => dir * ((mockSnapshot(a).price ?? 0) - (mockSnapshot(b).price ?? 0)));

beforeEach(() => {
  resetMockWorkspace();
  resetMockQuotes();
});

describe('WatchlistPanel rows', () => {
  it('shows last, change, change %, volume and day range for every symbol', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    const q = mockSnapshot('MSFT');
    await waitFor(() => expect(within(rowOf('MSFT')).queryByText('loading…')).toBeNull());
    const row = within(rowOf('MSFT'));
    expect(row.getByText(q.price?.toFixed(2) ?? '')).toBeInTheDocument();
    expect(row.getByText(`${q.dayLow?.toFixed(2)}–${q.dayHigh?.toFixed(2)}`)).toBeInTheDocument();
    expect(order()).toEqual(DEFAULT);
  });

  it('colours the change by sign', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await waitFor(() => expect(screen.queryByText('loading…')).toBeNull());
    for (const s of DEFAULT) {
      const change = mockSnapshot(s).change ?? 0;
      const cell = within(rowOf(s)).getByText(`${change > 0 ? '+' : ''}${change.toFixed(2)}`);
      expect(cell).toHaveClass(change > 0 ? 'up' : 'down');
    }
  });

  it('shows missing as "not found" and failed as "unavailable", never blank or zero', async () => {
    resetMockWorkspace(wlWith(['AAPL', 'ZZNOPE', 'FAILME']));
    renderPanel();
    await within(await screen.findByRole('button', { name: 'ZZNOPE' }).then((b) => b.closest('tr') as HTMLElement)).findByText('not found');
    expect(within(rowOf('FAILME')).getByText('unavailable')).toBeInTheDocument();
    expect(within(rowOf('ZZNOPE')).queryByText(/0\.00/)).toBeNull();
  });

  it('shows the Delayed badge only when quotes are delayed', async () => {
    renderPanel();
    await screen.findByText(mockSnapshot('AAPL').price?.toFixed(2) ?? '');
    expect(screen.queryByText('Delayed')).toBeNull();
  });

  it('shows the Delayed badge when quotes are delayed', async () => {
    setMockQuotesDelayed(true);
    renderPanel();
    expect(await screen.findByText('Delayed')).toBeInTheDocument();
  });

  it('calls setSymbol on row click and highlights the active symbol', async () => {
    const { setSymbol } = renderPanel('MSFT');
    await screen.findByRole('button', { name: 'AAPL' });
    expect(rowOf('MSFT')).toHaveAttribute('aria-current', 'true');
    expect(rowOf('AAPL')).not.toHaveAttribute('aria-current');
    await userEvent.click(screen.getByRole('button', { name: 'NVDA' }));
    expect(setSymbol).toHaveBeenCalledWith('NVDA');
  });
});

describe('WatchlistPanel row click', () => {
  it('selects the symbol when any cell of the row is clicked, once', async () => {
    const { setSymbol } = renderPanel('AAPL');
    await screen.findByRole('button', { name: 'MSFT' });
    await waitFor(() => expect(within(rowOf('MSFT')).queryByText('loading…')).toBeNull());
    await userEvent.click(within(rowOf('MSFT')).getByText(mockSnapshot('MSFT').price?.toFixed(2) ?? ''));
    expect(setSymbol).toHaveBeenCalledTimes(1);
    expect(setSymbol).toHaveBeenCalledWith('MSFT');
    await userEvent.click(screen.getByRole('button', { name: 'NVDA' }));
    expect(setSymbol).toHaveBeenCalledTimes(2);
  });

  it('removes with × without selecting the row', async () => {
    const { setSymbol } = renderPanel('AAPL');
    await screen.findByRole('button', { name: 'MSFT' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove MSFT' }));
    expect(setSymbol).not.toHaveBeenCalled();
    expect(order()).not.toContain('MSFT');
    await waitFor(() => expect(savedSymbols()).not.toContain('MSFT'));
  });
});

describe('WatchlistPanel sort', () => {
  it('cycles ascending, descending, off and really reorders the rows', async () => {
    renderPanel();
    await screen.findByText(mockSnapshot('AAPL').price?.toFixed(2) ?? '');
    const header = screen.getByRole('button', { name: 'Sort by last price' });
    // The mock must give a sort something to do.
    expect(byPrice(DEFAULT, 1)).not.toEqual(DEFAULT);
    expect(byPrice(DEFAULT, -1)).not.toEqual(DEFAULT);

    await userEvent.click(header);
    expect(order()).toEqual(byPrice(DEFAULT, 1));
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(header);
    expect(order()).toEqual(byPrice(DEFAULT, -1));
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(header);
    expect(order()).toEqual(DEFAULT);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'none');
  });

  it('does not save: the stored order and revision stay as they were', async () => {
    renderPanel();
    await screen.findByText(mockSnapshot('AAPL').price?.toFixed(2) ?? '');
    await userEvent.click(screen.getByRole('button', { name: 'Sort by last price' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sort by symbol' }));
    expect(order()).toEqual([...DEFAULT].sort());
    expect(savedSymbols()).toEqual(DEFAULT);
    expect(savedRevision()).toBe(1);
  });
});

describe('WatchlistPanel reorder', () => {
  it('moves a row with Alt+ArrowDown and Alt+ArrowUp, keeps focus, and saves the order', async () => {
    renderPanel();
    const aapl = await screen.findByRole('button', { name: 'AAPL' });
    aapl.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(order()).toEqual(['MSFT', 'AAPL', 'NVDA', 'AMZN', 'GOOGL']);
    expect(screen.getByRole('button', { name: 'AAPL' })).toHaveFocus();
    await waitFor(() => expect(savedSymbols()).toEqual(['MSFT', 'AAPL', 'NVDA', 'AMZN', 'GOOGL']));
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(savedSymbols()).toEqual(DEFAULT));
  });

  it('saves two quick moves in order without a revision conflict', async () => {
    renderPanel();
    const aapl = await screen.findByRole('button', { name: 'AAPL' });
    aapl.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{ArrowDown}{/Alt}');
    await waitFor(() => expect(savedSymbols()).toEqual(['MSFT', 'NVDA', 'AAPL', 'AMZN', 'GOOGL']));
    expect(savedRevision()).toBe(3);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  it('ignores a move past either end', async () => {
    renderPanel();
    const aapl = await screen.findByRole('button', { name: 'AAPL' });
    aapl.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(order()).toEqual(DEFAULT);
    expect(savedRevision()).toBe(1);
  });

  it('reorders by drag and drop and saves', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    fireEvent.dragStart(rowOf('GOOGL'));
    fireEvent.dragOver(rowOf('AAPL'));
    fireEvent.drop(rowOf('AAPL'));
    expect(order()).toEqual(['GOOGL', 'AAPL', 'MSFT', 'NVDA', 'AMZN']);
    await waitFor(() => expect(savedSymbols()).toEqual(['GOOGL', 'AAPL', 'MSFT', 'NVDA', 'AMZN']));
  });

  it('is disabled while sorted, says why, and works again after the sort is cleared', async () => {
    renderPanel();
    const aapl = await screen.findByRole('button', { name: 'AAPL' });
    expect(rowOf('AAPL')).toHaveAttribute('draggable', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Sort by symbol' }));
    expect(screen.getByText(/Reorder is off while the list is sorted/)).toBeVisible();
    expect(rowOf('AAPL')).toHaveAttribute('draggable', 'false');

    const before = order();
    screen.getByRole('button', { name: 'AAPL' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    fireEvent.dragStart(rowOf('GOOGL'));
    fireEvent.drop(rowOf('AAPL'));
    expect(order()).toEqual(before);
    expect(savedRevision()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Clear sort' }));
    expect(order()).toEqual(DEFAULT);
    expect(rowOf('AAPL')).toHaveAttribute('draggable', 'true');
    expect(aapl).toBeDefined();
  });
});

describe('WatchlistPanel conflicts', () => {
  it('on CONFLICT refetches, shows the server list, tells the user, and does not retry', async () => {
    renderPanel();
    const aapl = await screen.findByRole('button', { name: 'AAPL' });
    // Another tab changes the list (revision 1 -> 2) behind this panel's back.
    const other = ['NVDA', 'AAPL', 'MSFT'];
    await apiRequest(`/watchlists/${mockWorkspace().watchlists[0]?.id}`, { method: 'PUT', body: { revision: 1, symbols: other } });

    aapl.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument();
    await waitFor(() => expect(order()).toEqual(other));
    // A blind retry would have written revision 3.
    expect(savedRevision()).toBe(2);
    expect(savedSymbols()).toEqual(other);
  });
});

describe('WatchlistPanel add and remove', () => {
  it('adds a symbol from the search box and saves it', async () => {
    resetMockWorkspace(wlWith(['MSFT']));
    renderPanel();
    await screen.findByRole('button', { name: 'MSFT' });
    await userEvent.type(screen.getByRole('combobox', { name: 'Add symbol to watchlist' }), 'AAPL');
    await userEvent.click(await screen.findByText('Apple Inc.'));
    expect(await screen.findByRole('button', { name: 'AAPL' })).toBeInTheDocument();
    await waitFor(() => expect(savedSymbols()).toEqual(['MSFT', 'AAPL']));
  });

  it('does not add a duplicate', async () => {
    resetMockWorkspace(wlWith(['AAPL']));
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.type(screen.getByRole('combobox', { name: 'Add symbol to watchlist' }), 'AAPL');
    await userEvent.click(await screen.findByText('Apple Inc.'));
    expect(await screen.findByText('AAPL is already in this list.')).toBeInTheDocument();
    expect(savedRevision()).toBe(1);
  });

  it('removes a symbol and saves', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove MSFT' }));
    expect(order()).toEqual(['AAPL', 'NVDA', 'AMZN', 'GOOGL']);
    await waitFor(() => expect(savedSymbols()).toEqual(['AAPL', 'NVDA', 'AMZN', 'GOOGL']));
  });
});

describe('WatchlistPanel named lists', () => {
  it('creates a list, makes it active with PUT /workspace/active, and shows it empty', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.click(screen.getByRole('button', { name: 'New list' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New list name' }), 'Tech{Enter}');
    await screen.findByText(/This list is empty/);
    const ws = mockWorkspace();
    expect(ws.watchlists.map((w) => w.name)).toEqual(['Watchlist', 'Tech']);
    expect(ws.activeWatchlistId).toBe(ws.watchlists[1]?.id);
    expect(screen.getByRole('combobox', { name: 'Watchlist' })).toHaveDisplayValue('Tech');
  });

  it('switches the active list and stores only activeWatchlistId', async () => {
    const base = mockWorkspace();
    await apiRequest('/watchlists', { method: 'POST', body: { name: 'Second', symbols: ['TSLA'] } });
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    const second = mockWorkspace().watchlists[1] as Watchlist;
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Watchlist' }), second.id);
    expect(await screen.findByRole('button', { name: 'TSLA' })).toBeInTheDocument();
    await waitFor(() => expect(mockWorkspace().activeWatchlistId).toBe(second.id));
    expect(mockWorkspace().activeLayoutId).toBe(base.activeLayoutId);
  });

  it('renames a list', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.click(screen.getByRole('button', { name: 'Rename list' }));
    const input = screen.getByRole('textbox', { name: 'List name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Core{Enter}');
    await waitFor(() => expect(mockWorkspace().watchlists[0]?.name).toBe('Core'));
    expect(screen.getByRole('combobox', { name: 'Watchlist' })).toHaveDisplayValue('Core');
  });

  it('keeps the form open and explains when the server refuses a name', async () => {
    await apiRequest('/watchlists', { method: 'POST', body: { name: 'Taken' } });
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.click(screen.getByRole('button', { name: 'New list' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New list name' }), 'taken{Enter}');
    expect(await screen.findByText(/already in use/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New list name' })).toBeInTheDocument();
  });

  it('asks before it deletes, then deletes and adopts the server active list', async () => {
    await apiRequest('/watchlists', { method: 'POST', body: { name: 'Second', symbols: ['TSLA'] } });
    renderPanel();
    await screen.findByRole('button', { name: 'AAPL' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete list' }));
    expect(mockWorkspace().watchlists).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /Delete “Watchlist”/ }));
    expect(await screen.findByRole('button', { name: 'TSLA' })).toBeInTheDocument();
    expect(mockWorkspace().watchlists).toHaveLength(1);
  });
});
