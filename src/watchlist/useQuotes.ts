import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '@shared/types';
import { isAbortError, toDataError } from '../data';
import { fetchQuotes } from './api';
import { normKey } from './format';

/** The rate budget in docs/CONTRACT.md is computed for a 30 s poll. Do not shorten it. */
export const QUOTE_POLL_MS = 30_000;

export interface QuotesState {
  quotes: ReadonlyMap<string, Snapshot>;
  /** Upper-case symbols the server could not resolve. */
  missing: ReadonlySet<string>;
  /** Upper-case symbols whose fetch failed; retry on the next poll. */
  failed: ReadonlySet<string>;
  /** True once a response (or an error) has arrived for the current symbol set. */
  loaded: boolean;
  /** Message of the latest failed request, or null. Older data stays on screen. */
  error: string | null;
  refresh: () => void;
}

const EMPTY_MAP: ReadonlyMap<string, Snapshot> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Polls `GET /api/quotes` every QUOTE_POLL_MS, only while the page is visible. Becoming
 * visible again fetches at once, because the data may be minutes old. Symbol ORDER is not
 * part of the request key: a reorder changes no data, so it must not cost API calls.
 */
export function useQuotes(symbols: string[]): QuotesState {
  const key = useMemo(() => [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(','), [symbols]);
  const [state, setState] = useState<Omit<QuotesState, 'refresh' | 'loaded'> & { loadedKey: string | null }>({
    quotes: EMPTY_MAP, missing: EMPTY_SET, failed: EMPTY_SET, loadedKey: null, error: null,
  });
  const loadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (key === '') {
      setState({ quotes: EMPTY_MAP, missing: EMPTY_SET, failed: EMPTY_SET, loadedKey: null, error: null });
      loadRef.current = () => undefined;
      return;
    }
    const list = key.split(',');
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const load = () => {
      controller?.abort();
      const c = new AbortController();
      controller = c;
      fetchQuotes(list, c.signal).then(
        (res) => {
          if (disposed || c.signal.aborted) return;
          setState({
            quotes: new Map(res.quotes.map((q) => [normKey(q.symbol), q])),
            missing: new Set(res.missing.map(normKey)),
            failed: new Set(res.failed.map(normKey)),
            loadedKey: key,
            error: null,
          });
        },
        (e: unknown) => {
          if (disposed || isAbortError(e)) return;
          // Keep the last good data: a failed poll must not blank the list.
          setState((s) => ({ ...s, loadedKey: key, error: toDataError(e).message }));
        },
      );
    };
    const start = () => {
      if (timer === null) timer = setInterval(load, QUOTE_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (visible()) {
        load();
        start();
      } else {
        stop();
        controller?.abort();
      }
    };

    loadRef.current = load;
    if (visible()) {
      load();
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      stop();
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  const refresh = useCallback(() => loadRef.current(), []);
  const { loadedKey, ...rest } = state;
  return { ...rest, loaded: loadedKey === key, refresh };
}
