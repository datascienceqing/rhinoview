import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watchlist } from '@shared/types';
import { DataError } from '../data';

vi.mock('./api', () => ({
  fetchWatchlists: vi.fn(),
  createWatchlist: vi.fn(),
  updateWatchlist: vi.fn(),
  deleteWatchlist: vi.fn(),
  setActiveWatchlist: vi.fn(),
  fetchQuotes: vi.fn(),
}));
import * as api from './api';
import { useWatchlists } from './useWatchlists';

const m = vi.mocked(api);
const wl = (id: string, symbols: string[] = ['AAPL']): Watchlist => ({
  id, name: id, symbols, revision: 1, createdAt: 1, updatedAt: 1,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.fetchWatchlists.mockResolvedValue({ watchlists: [wl('a'), wl('b')], activeWatchlistId: 'a' });
  m.setActiveWatchlist.mockResolvedValue({} as never);
});

async function ready() {
  const hook = renderHook(() => useWatchlists());
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

describe('useWatchlists write queue', () => {
  it('drops queued writes for the failed list only: a queued create still runs', async () => {
    m.updateWatchlist.mockRejectedValue(new DataError('CONFLICT', 'stale', { status: 409 }));
    m.createWatchlist.mockResolvedValue(wl('c', []));
    const { result } = await ready();

    let created: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result.current.setSymbols('a', ['AAPL', 'MSFT']); // fails with CONFLICT
      result.current.setSymbols('a', ['AAPL', 'MSFT', 'NVDA']); // queued for the same list: dropped
      created = result.current.create('Other'); // unrelated: must run
    });
    await expect(created).resolves.toBe(true);
    expect(m.updateWatchlist).toHaveBeenCalledTimes(1);
    expect(m.createWatchlist).toHaveBeenCalledWith('Other');
    await waitFor(() => expect(result.current.notice?.text).toMatch(/changed somewhere else/));
  });

  it('does not drop a queued write for another list when one list fails', async () => {
    m.updateWatchlist.mockImplementation((id) =>
      id === 'a' ? Promise.reject(new DataError('CONFLICT', 'stale')) : Promise.resolve(wl('b', ['MSFT'])),
    );
    const { result } = await ready();
    act(() => {
      result.current.setSymbols('a', ['X']);
      result.current.setSymbols('b', ['MSFT']);
    });
    await waitFor(() => expect(m.updateWatchlist).toHaveBeenCalledTimes(2));
    expect(m.updateWatchlist.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('treats a failed refetch after a successful DELETE as a deleted list, not a failed write', async () => {
    m.deleteWatchlist.mockResolvedValue({} as never);
    const { result } = await ready();
    m.fetchWatchlists.mockRejectedValue(new DataError('NETWORK', 'down'));

    let done = false;
    await act(async () => {
      done = await result.current.remove('a');
    });
    expect(done).toBe(true);
    expect(result.current.lists.map((w) => w.id)).toEqual(['b']);
    expect(result.current.activeId).toBe('b');
    expect(result.current.notice?.kind).toBe('info');
    expect(result.current.notice?.text).not.toMatch(/not saved/);
  });
});
