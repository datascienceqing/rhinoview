import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotesResponse } from '@shared/types';

vi.mock('./api', () => ({ fetchQuotes: vi.fn() }));
import { fetchQuotes } from './api';
import { QUOTE_POLL_MS, useQuotes } from './useQuotes';

const fetchMock = vi.mocked(fetchQuotes);
const reply = (): QuotesResponse => ({ quotes: [], missing: [], failed: [] });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(reply()));
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useQuotes polling', () => {
  it('polls every 30 seconds while the page is visible', async () => {
    expect(QUOTE_POLL_MS).toBe(30_000);
    renderHook(() => useQuotes(['AAPL', 'MSFT']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not poll while the page is hidden, and fetches at once when it is visible again', async () => {
    renderHook(() => useQuotes(['AAPL']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => setVisibility('hidden'));
    await act(() => vi.advanceTimersByTimeAsync(5 * QUOTE_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => setVisibility('visible'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(QUOTE_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not fetch at all when it starts hidden', async () => {
    setVisibility('hidden');
    renderHook(() => useQuotes(['AAPL']));
    await act(() => vi.advanceTimersByTimeAsync(2 * QUOTE_POLL_MS));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch for an empty list', async () => {
    renderHook(() => useQuotes([]));
    await act(() => vi.advanceTimersByTimeAsync(2 * QUOTE_POLL_MS));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch again when the same symbols are only reordered', async () => {
    const { rerender } = renderHook(({ s }) => useQuotes(s), { initialProps: { s: ['AAPL', 'MSFT'] } });
    rerender({ s: ['MSFT', 'AAPL'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ s: ['MSFT', 'AAPL', 'NVDA'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(0));
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useQuotes(['AAPL']));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(3 * QUOTE_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good quotes when a later poll fails', async () => {
    const q = { symbol: 'AAPL', price: 1, change: 0, changePercent: 0, previousClose: 1, dayOpen: 1, dayHigh: 1, dayLow: 1, dayVolume: 1, updated: null, delayed: false };
    fetchMock.mockResolvedValueOnce({ quotes: [q], missing: [], failed: [] });
    fetchMock.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useQuotes(['AAPL']));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.quotes.get('AAPL')?.price).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(QUOTE_POLL_MS));
    expect(result.current.error).toBe('down');
    expect(result.current.quotes.get('AAPL')?.price).toBe(1);
  });
});
