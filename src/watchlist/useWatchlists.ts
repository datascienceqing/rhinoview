import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, Watchlist } from '@shared/types';
import { isAbortError, toDataError } from '../data';
import {
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  setActiveWatchlist,
  updateWatchlist,
} from './api';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export interface WatchlistsApi {
  status: 'loading' | 'ready' | 'error';
  lists: Watchlist[];
  activeId: EntityId | null;
  notice: Notice | null;
  dismissNotice: () => void;
  reload: () => void;
  select: (id: EntityId) => void;
  create: (name: string) => Promise<boolean>;
  rename: (id: EntityId, name: string) => Promise<boolean>;
  remove: (id: EntityId) => Promise<boolean>;
  /** Optimistic: the list changes at once and is saved in order, one write at a time. */
  setSymbols: (id: EntityId, symbols: string[]) => void;
}

const CONFLICT_TEXT =
  'This list was changed somewhere else. Your change was not saved. The current list is shown.';

/**
 * Watchlist state plus every write, through /api/watchlists.
 *
 * Writes are SERIALISED. Two quick edits (for example two Alt+Down presses) would
 * otherwise both carry the same revision, and the second would conflict with the first.
 * Each queued write reads the latest revision when it runs.
 *
 * On any failed write the client refetches and adopts the server's state, then raises
 * the epoch so writes queued behind the failure are dropped. On CONFLICT in particular
 * the contract forbids a blind retry: the user sees the current list and decides again.
 */
export function useWatchlists(): WatchlistsApi {
  const [status, setStatus] = useState<WatchlistsApi['status']>('loading');
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [activeId, setActiveId] = useState<EntityId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const listsRef = useRef<Watchlist[]>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const epoch = useRef(0);
  const pending = useRef(0);

  const commit = useCallback((next: Watchlist[]) => {
    listsRef.current = next;
    setLists(next);
  }, []);

  const adopt = useCallback(
    async (signal?: AbortSignal) => {
      const res = await fetchWatchlists(signal);
      commit(res.watchlists);
      setActiveId(res.activeWatchlistId);
    },
    [commit],
  );

  const load = useCallback(
    (signal?: AbortSignal) => {
      setStatus('loading');
      adopt(signal).then(
        () => setStatus('ready'),
        (e: unknown) => {
          if (!isAbortError(e)) setStatus('error');
        },
      );
    },
    [adopt],
  );

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  /** Runs `task` after every earlier write. Resolves false when it was dropped or failed. */
  const enqueue = useCallback(
    (task: () => Promise<boolean>): Promise<boolean> => {
      const mine = epoch.current;
      pending.current += 1;
      const run = chain.current.then(async () => {
        try {
          if (epoch.current !== mine) return false;
          return await task();
        } catch (e) {
          epoch.current += 1;
          const err = toDataError(e);
          setNotice({
            kind: 'error',
            text: err.code === 'CONFLICT' ? CONFLICT_TEXT : `The change was not saved. ${err.message}`,
          });
          // Roll back optimistic edits to what the server really holds.
          await adopt().catch(() => undefined);
          return false;
        } finally {
          pending.current -= 1;
        }
      });
      chain.current = run;
      return run;
    },
    [adopt],
  );

  const save = useCallback(
    (id: EntityId, patch: { name?: string; symbols?: string[] }) =>
      enqueue(async () => {
        const current = listsRef.current.find((w) => w.id === id);
        if (!current) return false;
        const saved = await updateWatchlist(id, { revision: current.revision, ...patch });
        // While more writes wait, keep the local symbols (they are newer than the reply).
        const settled = pending.current <= 1;
        commit(
          listsRef.current.map((w) =>
            w.id === id ? (settled ? saved : { ...w, name: saved.name, revision: saved.revision, updatedAt: saved.updatedAt }) : w,
          ),
        );
        return true;
      }),
    [commit, enqueue],
  );

  const setSymbols = useCallback(
    (id: EntityId, symbols: string[]) => {
      commit(listsRef.current.map((w) => (w.id === id ? { ...w, symbols } : w)));
      void save(id, { symbols });
    },
    [commit, save],
  );

  const rename = useCallback((id: EntityId, name: string) => save(id, { name }), [save]);

  const select = useCallback(
    (id: EntityId) => {
      setActiveId(id);
      void enqueue(async () => {
        await setActiveWatchlist(id);
        return true;
      });
    },
    [enqueue],
  );

  const create = useCallback(
    (name: string) =>
      enqueue(async () => {
        const created = await createWatchlist(name);
        commit([...listsRef.current, created]);
        setActiveId(created.id);
        await setActiveWatchlist(created.id);
        return true;
      }),
    [commit, enqueue],
  );

  const remove = useCallback(
    (id: EntityId) =>
      enqueue(async () => {
        await deleteWatchlist(id);
        // The server picks the next active list; take its answer rather than guess.
        await adopt();
        return true;
      }),
    [adopt, enqueue],
  );

  return {
    status,
    lists,
    activeId,
    notice,
    dismissNotice: () => setNotice(null),
    reload: () => load(),
    select,
    create,
    rename,
    remove,
    setSymbols,
  };
}

