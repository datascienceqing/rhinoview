import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Bar, BarsQuery, Timeframe } from '@shared/types';
import { useDataSource } from './DataSourceContext';
import type { DataSource } from './DataSource';
import { LatestOnly } from './latest';
import { isAbortError, toDataError } from './errors';
import type { DataError } from './errors';
import { nowSeconds } from './time';
import { CHUNK_SECONDS, MAX_EMPTY_PROBES } from './windows';

export interface BarHistoryState {
  /** `loading` covers the first request for the current symbol+timeframe only. */
  status: 'loading' | 'ready' | 'error';
  /** Ascending, strictly increasing, de-duplicated. Empty while loading/after error. */
  bars: Bar[];
  error: DataError | null;
  loadingOlder: boolean;
  /** Last failed older-history request; blocks auto-retry until `retryOlder`. */
  olderError: DataError | null;
  /** No older bars exist (several consecutive empty windows). Reset per symbol/timeframe. */
  exhausted: boolean;
  /**
   * The most recent response was clipped to the newest bars of its window. There is
   * no hole (truncation drops the oldest end and the next request continues from
   * there); it just means more history is available. Reflects the latest response
   * only, so it clears once a later response is complete.
   */
  truncated: boolean;
}

type Action =
  | { type: 'reset' }
  | { type: 'loaded'; bars: Bar[]; exhausted: boolean; truncated: boolean }
  | { type: 'failed'; error: DataError }
  | { type: 'olderStart' }
  | { type: 'olderLoaded'; bars: Bar[]; exhausted: boolean; truncated: boolean }
  | { type: 'olderFailed'; error: DataError };

const INITIAL: BarHistoryState = {
  status: 'loading',
  bars: [],
  error: null,
  loadingOlder: false,
  olderError: null,
  exhausted: false,
  truncated: false,
};

function reducer(state: BarHistoryState, action: Action): BarHistoryState {
  switch (action.type) {
    case 'reset':
      return INITIAL;
    case 'loaded':
      return {
        ...INITIAL,
        status: 'ready',
        bars: action.bars,
        exhausted: action.exhausted,
        truncated: action.truncated,
      };
    case 'failed':
      return { ...INITIAL, status: 'error', error: action.error };
    case 'olderStart':
      return { ...state, loadingOlder: true, olderError: null };
    case 'olderLoaded':
      return {
        ...state,
        loadingOlder: false,
        bars: prepend(state.bars, action.bars),
        exhausted: action.exhausted,
        truncated: action.truncated,
      };
    case 'olderFailed':
      return { ...state, loadingOlder: false, olderError: action.error };
  }
}

/** Prepend `older` to `bars`, dropping anything not strictly older than the current first bar. */
export function prepend(bars: Bar[], older: Bar[]): Bar[] {
  const first = bars[0];
  const fresh = first ? older.filter((b) => b.time < first.time) : older;
  return fresh.length === 0 ? bars : [...fresh, ...bars];
}

interface Chunk {
  bars: Bar[];
  truncated: boolean;
  exhausted: boolean;
}

/**
 * Fetch the newest non-empty window ending at `to` (inclusive, Unix seconds).
 * An empty window widens the span and steps further back instead of giving up,
 * because empty != "no more history" (weekends, holidays, thin trading). After
 * MAX_EMPTY_PROBES consecutive empties we conclude we're past the start of the
 * series and report `exhausted` so nobody asks again.
 *
 * `from` is floored at 0 and a window that reaches 0 is the last one: nothing can
 * be older than the epoch. Without the floor the doubling ladder walks below 0 for
 * any series that starts long ago, and the server may reject a negative `from`;
 * a client must not depend on the server clamping it.
 */
export async function fetchBackwards(
  ds: DataSource,
  base: Pick<BarsQuery, 'symbol' | 'timeframe'>,
  to: number,
  signal: AbortSignal,
): Promise<Chunk> {
  let windowTo = to;
  let span = CHUNK_SECONDS[base.timeframe];
  for (let probe = 0; probe <= MAX_EMPTY_PROBES; probe++) {
    if (windowTo < 0) break; // asked to go before the epoch: nothing there
    const from = Math.max(0, windowTo - span);
    const res = await ds.getBars({ ...base, from, to: windowTo }, { signal });
    if (res.bars.length > 0) return { bars: res.bars, truncated: res.truncated, exhausted: false };
    if (from === 0) break; // the window reached the epoch and was empty: that is the end
    windowTo = from - 1;
    span *= 2;
  }
  return { bars: [], truncated: false, exhausted: true };
}

export interface BarHistory extends BarHistoryState {
  /** Request one more window of older bars. Safe to call repeatedly; see guards below. */
  loadOlder: () => void;
  /** Re-run the failed initial load. */
  reload: () => void;
  /** Re-run the failed older-history load. */
  retryOlder: () => void;
}

/**
 * Bars for one symbol+timeframe, with lazy older history.
 *
 * Guards for `loadOlder` (it is called from a scroll handler that fires constantly):
 *  - ignored until the initial load is ready;
 *  - ignored while a request is in flight (no concurrent duplicates);
 *  - ignored once `exhausted` (never re-request a range known to be empty);
 *  - ignored after an error until the user retries (no hammering a rate limit).
 * Switching symbol/timeframe cancels both requests, and `LatestOnly` guarantees a
 * response for the previous key can never land in the new key's state.
 */
export function useBarHistory(symbol: string, timeframe: Timeframe): BarHistory {
  const ds = useDataSource();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [reloadCount, bumpReload] = useReducer((n: number) => n + 1, 0);
  const stateRef = useRef(state);
  const initialRunner = useRef(new LatestOnly());
  const olderRunner = useRef(new LatestOnly());
  const inFlightOlder = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  });

  useEffect(() => {
    const initial = initialRunner.current;
    const older = olderRunner.current;
    inFlightOlder.current = false;
    dispatch({ type: 'reset' });
    initial
      .run((signal) => fetchBackwards(ds, { symbol, timeframe }, nowSeconds(), signal))
      .then(
        (chunk) =>
          dispatch({
            type: 'loaded',
            bars: chunk.bars,
            exhausted: chunk.exhausted,
            truncated: chunk.truncated,
          }),
        (e: unknown) => {
          if (!isAbortError(e)) dispatch({ type: 'failed', error: toDataError(e) });
        },
      );
    return () => {
      initial.cancel();
      older.cancel();
      inFlightOlder.current = false;
    };
  }, [ds, symbol, timeframe, reloadCount]);

  const requestOlder = useCallback(() => {
    const current = stateRef.current;
    const oldest = current.bars[0];
    if (!oldest) return;
    inFlightOlder.current = true;
    dispatch({ type: 'olderStart' });
    olderRunner.current
      .run((signal) => fetchBackwards(ds, { symbol, timeframe }, oldest.time - 1, signal))
      .then(
        (chunk) => {
          inFlightOlder.current = false;
          dispatch({
            type: 'olderLoaded',
            bars: chunk.bars,
            exhausted: chunk.exhausted,
            truncated: chunk.truncated,
          });
        },
        (e: unknown) => {
          // Aborted/superseded: the effect cleanup already reset the in-flight flag
          // for the new key, so leave it alone.
          if (isAbortError(e)) return;
          inFlightOlder.current = false;
          dispatch({ type: 'olderFailed', error: toDataError(e) });
        },
      );
  }, [ds, symbol, timeframe]);

  const loadOlder = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== 'ready' || s.exhausted || s.olderError) return;
    if (inFlightOlder.current) return;
    requestOlder();
  }, [requestOlder]);

  const retryOlder = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== 'ready' || s.exhausted || inFlightOlder.current) return;
    requestOlder();
  }, [requestOlder]);

  return { ...state, loadOlder, reload: bumpReload, retryOlder };
}
