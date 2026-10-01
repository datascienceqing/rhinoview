import { useCallback, useEffect, useRef, useState } from 'react';
import { LatestOnly } from './latest';
import { isAbortError, toDataError } from './errors';
import type { DataError } from './errors';

export type AsyncState<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: DataError };

const IDLE: AsyncState<never> = { status: 'idle', data: null, error: null };
const LOADING: AsyncState<never> = { status: 'loading', data: null, error: null };

/**
 * Runs `task` whenever `key` changes (or `reload()` is called); `key === null` means
 * idle. Stale responses are dropped by `LatestOnly`, and the in-flight request is
 * aborted on key change and on unmount.
 *
 * The task is read through a ref so callers can pass an inline closure without it
 * being an effect dependency — `key` is the single source of "what to fetch".
 */
export function useAsync<T>(
  key: string | null,
  task: (signal: AbortSignal) => Promise<T>,
): AsyncState<T> & { reload: () => void } {
  // The state remembers which key produced it, so a render with a new key can never
  // briefly expose the previous key's data (e.g. last symbol's quote under a new one).
  const [stored, setStored] = useState<{ key: string | null; state: AsyncState<T> }>({
    key: null,
    state: IDLE,
  });
  const [reloadCount, setReloadCount] = useState(0);
  const taskRef = useRef(task);
  const runner = useRef(new LatestOnly());

  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    const latest = runner.current;
    if (key === null) {
      latest.cancel();
      setStored({ key: null, state: IDLE });
      return;
    }
    setStored({ key, state: LOADING });
    latest
      .run((signal) => taskRef.current(signal))
      .then(
        (data) => setStored({ key, state: { status: 'success', data, error: null } }),
        (e: unknown) => {
          if (isAbortError(e)) return;
          setStored({ key, state: { status: 'error', data: null, error: toDataError(e) } });
        },
      );
    return () => latest.cancel();
  }, [key, reloadCount]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const state: AsyncState<T> = stored.key === key ? stored.state : key === null ? IDLE : LOADING;
  return { ...state, reload };
}
