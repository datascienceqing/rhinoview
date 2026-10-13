import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResult } from '@shared/types';
import { DataError } from '../data';
import { SymbolSearch } from './SymbolSearch';
import { fakeDataSource, renderWithDataSource } from './testUtils';

const aapl: SearchResult = { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'XNAS', type: 'CS', currency: 'USD', active: true };
const mx: SearchResult = { symbol: 'AAPL.MX', name: 'Apple Inc. (BMV)', exchange: null, type: 'CS', currency: 'MXN', active: true };

const respond = (results: SearchResult[]) =>
  vi.fn((query: string) => Promise.resolve({ query, results }));

describe('SymbolSearch debounce', () => {
  it('waits for typing to pause (~250ms) and then searches once with the final text', async () => {
    const searchSymbols = respond([aapl]);
    renderWithDataSource(<SymbolSearch onSelect={() => {}} />, fakeDataSource({ searchSymbols }));
    const user = userEvent.setup();

    await user.type(screen.getByRole('combobox'), 'aapl');
    expect(searchSymbols).not.toHaveBeenCalled();

    await waitFor(() => expect(searchSymbols).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(searchSymbols.mock.calls[0]?.[0]).toBe('aapl');
  });

  it('does not search for blank input', async () => {
    const searchSymbols = respond([]);
    renderWithDataSource(<SymbolSearch onSelect={() => {}} debounceMs={20} />, fakeDataSource({ searchSymbols }));
    await userEvent.setup().type(screen.getByRole('combobox'), '   ');
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(searchSymbols).not.toHaveBeenCalled();
  });

  it('never shows results from a slow earlier query over a newer one', async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    const searchSymbols = vi.fn((query: string) => {
      if (query === 'a') {
        // Ignores the abort signal on purpose: structural protection must not rely on it.
        return new Promise((resolve) => {
          releaseSlow = () => resolve({ query, results: [mx] });
        });
      }
      return Promise.resolve({ query, results: [aapl] });
    });
    renderWithDataSource(
      <SymbolSearch onSelect={() => {}} debounceMs={10} />,
      fakeDataSource({ searchSymbols: searchSymbols as never }),
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'a');
    await waitFor(() => expect(searchSymbols).toHaveBeenCalledWith('a', expect.anything()));
    await user.type(screen.getByRole('combobox'), 'a');
    expect(await screen.findByRole('option', { name: /Apple Inc\./ })).toBeInTheDocument();

    releaseSlow(undefined); // the stale 'a' response arrives late
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('AAPL.MX')).not.toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });
});

describe('SymbolSearch results and keyboard', () => {
  async function openWithResults(onSelect = vi.fn()) {
    renderWithDataSource(<SymbolSearch onSelect={onSelect} debounceMs={10} />, fakeDataSource({ searchSymbols: respond([aapl, mx]) }));
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'aapl');
    await screen.findAllByRole('option');
    return { user, onSelect, input: screen.getByRole('combobox') };
  }

  it('shows symbol, name and exchange, with a dash for a missing exchange', async () => {
    await openWithResults();
    const [first, second] = screen.getAllByRole('option');
    expect(first).toHaveTextContent('AAPL');
    expect(first).toHaveTextContent('Apple Inc.');
    expect(first).toHaveTextContent('XNAS');
    expect(second).toHaveTextContent('—');
  });

  it('moves the highlight with ArrowDown/ArrowUp (wrapping) and selects with Enter', async () => {
    const { user, onSelect, input } = await openWithResults();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]?.id);
    await user.keyboard('{ArrowDown}'); // wraps
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}'); // wraps back
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(mx);
  });

  it('Enter with nothing highlighted takes the top result, then clears and closes the box', async () => {
    const { user, onSelect, input } = await openWithResults();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(aapl);
    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes the list without selecting', async () => {
    const { user, onSelect } = await openWithResults();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects on click', async () => {
    const { user, onSelect } = await openWithResults();
    await user.click(screen.getAllByRole('option')[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(mx);
  });
});

describe('SymbolSearch states', () => {
  async function typeInto(ds: ReturnType<typeof fakeDataSource>, text: string) {
    renderWithDataSource(<SymbolSearch onSelect={() => {}} debounceMs={10} />, ds);
    await userEvent.setup().type(screen.getByRole('combobox'), text);
  }

  it('shows a searching state while the request is in flight', async () => {
    await typeInto(fakeDataSource({ searchSymbols: () => new Promise(() => {}) }), 'ap');
    expect(await screen.findByText('Searching…')).toBeInTheDocument();
  });

  it('explains zero results with real copy instead of a blank dropdown', async () => {
    await typeInto(fakeDataSource({ searchSymbols: respond([]) }), 'zzzzzz');
    expect(await screen.findByText(/No symbols match “zzzzzz”/)).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('shows rate-limit copy with the wait time and a retry that re-runs the search', async () => {
    const searchSymbols = vi
      .fn()
      .mockRejectedValueOnce(new DataError('RATE_LIMITED', 'x', { retryAfterSeconds: 12 }))
      .mockResolvedValueOnce({ query: 'ap', results: [aapl] });
    await typeInto(fakeDataSource({ searchSymbols }), 'ap');
    expect(await screen.findByText(/Try again in 12 seconds/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option')).toBeInTheDocument();
  });

  it('shows network-loss copy', async () => {
    await typeInto(fakeDataSource({ searchSymbols: () => Promise.reject(new DataError('NETWORK', 'x')) }), 'ap');
    expect(await screen.findByText(/Connection lost/)).toBeInTheDocument();
  });

  it('shows upstream-error copy', async () => {
    await typeInto(fakeDataSource({ searchSymbols: () => Promise.reject(new DataError('UPSTREAM_ERROR', 'x')) }), 'ap');
    expect(await screen.findByText(/Data provider error/)).toBeInTheDocument();
  });
});

describe('SymbolSearch Enter before the results arrive', () => {
  it('picks the exact symbol when the results arrive', async () => {
    const onSelect = vi.fn();
    const searchSymbols = respond([mx, aapl]);
    renderWithDataSource(<SymbolSearch onSelect={onSelect} debounceMs={30} />, fakeDataSource({ searchSymbols }));
    await userEvent.setup().type(screen.getByRole('combobox'), 'aapl{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(aapl));
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('forgets the Enter when the user types again', async () => {
    const onSelect = vi.fn();
    renderWithDataSource(<SymbolSearch onSelect={onSelect} debounceMs={30} />, fakeDataSource({ searchSymbols: respond([aapl]) }));
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'aa{Enter}p');
    await screen.findByRole('option');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('SymbolSearch type-to-search', () => {
  function renderPage(typeToSearch = true) {
    const onSelect = vi.fn();
    renderWithDataSource(
      <>
        <button type="button">Elsewhere</button>
        <input aria-label="Other field" />
        <div role="dialog" aria-label="Dialog">
          <button type="button">In dialog</button>
        </div>
        <SymbolSearch onSelect={onSelect} debounceMs={10} typeToSearch={typeToSearch} />
      </>,
      fakeDataSource({ searchSymbols: respond([aapl]) }),
    );
    return { onSelect, user: userEvent.setup(), input: screen.getByRole('combobox') };
  }

  it('starts a search from a letter typed anywhere, and Enter shows the symbol', async () => {
    const { onSelect, user, input } = renderPage();
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await user.keyboard('aapl');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('aapl');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(aapl));
  });

  it('starts from the page body too', async () => {
    const { user, input } = renderPage();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('M');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('M');
  });

  it('leaves keys alone in a text field, in a dialog, with a modifier, and when it is off', async () => {
    const { user, input } = renderPage();
    const other = screen.getByRole('textbox', { name: 'Other field' });
    await user.click(other);
    await user.keyboard('x');
    expect(other).toHaveValue('x');
    screen.getByRole('button', { name: 'In dialog' }).focus();
    await user.keyboard('y');
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await user.keyboard('{Control>}c{/Control}{Meta>}k{/Meta}{Alt>}z{/Alt}');
    await user.keyboard(' ');
    expect(input).toHaveValue('');
    expect(input).not.toHaveFocus();
  });

  it('does nothing without the option', async () => {
    const { user, input } = renderPage(false);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await user.keyboard('a');
    expect(input).toHaveValue('');
  });
});
