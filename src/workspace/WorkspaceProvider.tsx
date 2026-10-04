/**
 * The persistent workspace provider: loads the named layouts from the proxy, exposes
 * the active one through the frozen `ActiveChartApi`, and saves edits back.
 *
 * Saving rules (docs/CONTRACT.md, "Workspace"):
 *  - Edits apply locally at once and are written with ONE debounced PUT (500 ms) that
 *    carries the revision the layout was last known at.
 *  - Writes for one layout are serialised, so the revision is always the latest the
 *    server gave us and a burst of edits never conflicts with itself.
 *  - On CONFLICT (or any rejection that retrying cannot fix) we do NOT retry. We drop
 *    the unsaved edit, refetch, adopt the server's version and tell the user.
 *  - Only transient failures (network, 5xx) keep the edit for a user-triggered retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChartLayout, CreateLayoutBody, EntityId, UpdateLayoutBody, Workspace } from '@shared/types';
import { MAX_NAME_LENGTH } from '@shared/types';
import { apiRequest, toDataError } from '../data';
import { isMigrated, loadIndicators, retireLegacyIndicators } from '../panes/storage';
import { ActiveChartContext } from './ActiveChartContext';
import { LayoutsContext } from './layoutsContext';
import type { ActionResult, LayoutsApi, SaveState, WorkspaceStatus } from './layoutsContext';
import { DEFAULT_ACTIVE_CHART } from './types';
import type { ActiveChart, ActiveChartApi } from './types';

export const SAVE_DEBOUNCE_MS = 500;

/** The fields an edit can change. `name` is excluded: renames are explicit, awaited actions. */
type Patch = Partial<Pick<UpdateLayoutBody, 'symbol' | 'timeframe' | 'chartType' | 'indicators'>>;

interface LayoutsResponse {
  layouts: ChartLayout[];
  activeLayoutId: EntityId;
}

const CONFLICT_NOTICE =
  'This layout was changed elsewhere. Showing the latest saved version; your last edit was not saved.';

function messageOf(e: unknown): string {
  const err = toDataError(e);
  if (err.code === 'NETWORK') return 'Could not reach the server. Check your connection and try again.';
  return err.message;
}

/** Errors a repeat of the same write cannot fix: the server's answer is final for that edit. */
function isFinal(code: string): boolean {
  return code === 'CONFLICT' || code === 'BAD_REQUEST' || code === 'NOT_FOUND';
}

/** "Main copy", "Main copy 2", ... — the first name no layout uses (case-insensitive), within the length limit. */
function copyName(base: string, taken: readonly { name: string }[]): string {
  const used = new Set(taken.map((l) => l.name.toLowerCase()));
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [layouts, setLayouts] = useState<ChartLayout[]>([]);
  const [activeId, setActiveIdState] = useState<EntityId | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [notice, setNotice] = useState<string | null>(null);
  // Before the workspace loads, or when it cannot: the chart still works, unsaved.
  const [local, setLocal] = useState<ActiveChart>(DEFAULT_ACTIVE_CHART);

  // Mutable machinery. Refs mirror state so async callbacks always see the latest values.
  const layoutsRef = useRef<ChartLayout[]>([]);
  const activeIdRef = useRef<EntityId | null>(null);
  const pending = useRef(new Map<EntityId, Patch>());
  const timers = useRef(new Map<EntityId, ReturnType<typeof setTimeout>>());
  const chains = useRef(new Map<EntityId, Promise<unknown>>());
  const failed = useRef(new Set<EntityId>());
  // Layouts whose refused edit is still on screen because refetching the server version failed.
  const needsAdopt = useRef(new Set<EntityId>());
  const inflight = useRef(0);
  const loadSeq = useRef(0);
  const migrationStarted = useRef(false);
  const statusRef = useRef<WorkspaceStatus>('loading');
  // Edits made while the workspace is still loading; applied to the active layout once it arrives.
  const loadingEdits = useRef<Patch>({});

  const setLayoutList = useCallback((next: ChartLayout[]) => {
    layoutsRef.current = next;
    setLayouts(next);
  }, []);
  const setActive = useCallback((id: EntityId | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  const refreshSaveState = useCallback(() => {
    if (failed.current.size > 0) setSaveState('error');
    else setSaveState(pending.current.size > 0 || inflight.current > 0 ? 'saving' : 'saved');
  }, []);

  const clearTimer = useCallback((id: EntityId) => {
    const t = timers.current.get(id);
    if (t !== undefined) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const enqueue = useCallback(<T,>(id: EntityId, task: () => Promise<T>): Promise<T> => {
    const prev = chains.current.get(id) ?? Promise.resolve();
    // Tasks never reject (they handle their own errors), but a stuck chain would freeze saving: guard anyway.
    const next = prev.then(task, task);
    chains.current.set(id, next);
    return next;
  }, []);

  /** Refetch and adopt the server's state for `id`. The only response to a write the server refused for good. */
  const adoptServer = useCallback(
    async (id: EntityId, message: string) => {
      pending.current.delete(id);
      clearTimer(id);
      try {
        const fresh = await apiRequest<LayoutsResponse>('/layouts');
        const serverCopy = fresh.layouts.find((l) => l.id === id);
        const merged = layoutsRef.current.filter((l) => l.id !== id || serverCopy);
        const next = merged.map((l) => (l.id === id && serverCopy ? serverCopy : l));
        for (const l of fresh.layouts) if (!next.some((x) => x.id === l.id)) next.push(l);
        setLayoutList(next);
        if (!next.some((l) => l.id === activeIdRef.current)) setActive(fresh.activeLayoutId);
        failed.current.delete(id);
        needsAdopt.current.delete(id);
        setNotice(message);
      } catch (e) {
        failed.current.add(id);
        needsAdopt.current.add(id);
        setNotice(`${message} Could not load the saved version: ${messageOf(e)}`);
      }
      refreshSaveState();
    },
    [clearTimer, refreshSaveState, setActive, setLayoutList],
  );

  /** Send the pending edit of `id`, if any. Runs inside the layout's chain; never throws. */
  const writePending = useCallback(
    async (id: EntityId, keepalive = false): Promise<void> => {
      const patch = pending.current.get(id);
      if (!patch) return;
      const layout = layoutsRef.current.find((l) => l.id === id);
      if (!layout) {
        pending.current.delete(id);
        return;
      }
      pending.current.delete(id);
      inflight.current += 1;
      refreshSaveState();
      try {
        const saved = await apiRequest<ChartLayout>(`/layouts/${id}`, {
          method: 'PUT',
          body: {
            revision: layout.revision,
            ...patch,
          } satisfies UpdateLayoutBody,
          keepalive,
        });
        // Keep our fields: the user may have edited again while this was in flight.
        setLayoutList(
          layoutsRef.current.map((l) =>
            l.id === id ? { ...l, revision: saved.revision, updatedAt: saved.updatedAt } : l,
          ),
        );
        failed.current.delete(id);
      } catch (e) {
        const err = toDataError(e);
        if (isFinal(err.code)) {
          await adoptServer(id, err.code === 'CONFLICT' ? CONFLICT_NOTICE : `Your edit was not saved: ${err.message}`);
        } else {
          // Transient. Keep the edit (newer edits win) for the user's Retry.
          pending.current.set(id, { ...patch, ...pending.current.get(id) });
          failed.current.add(id);
        }
      } finally {
        inflight.current -= 1;
        refreshSaveState();
      }
    },
    [adoptServer, refreshSaveState, setLayoutList],
  );

  const flush = useCallback(
    (id: EntityId, keepalive = false): Promise<void> => {
      clearTimer(id);
      return enqueue(id, () => writePending(id, keepalive));
    },
    [clearTimer, enqueue, writePending],
  );

  /** Apply an edit to the active layout locally and schedule its save. */
  const edit = useCallback(
    (patch: Patch) => {
      const id = activeIdRef.current;
      if (id === null || !layoutsRef.current.some((l) => l.id === id)) {
        setLocal((c) => ({ ...c, ...patch }));
        if (statusRef.current === 'loading') loadingEdits.current = { ...loadingEdits.current, ...patch };
        return;
      }
      setLayoutList(layoutsRef.current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
      pending.current.set(id, { ...pending.current.get(id), ...patch });
      failed.current.delete(id); // a new edit supersedes a failed one; both are in the patch
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void flush(id);
        }, SAVE_DEBOUNCE_MS),
      );
      refreshSaveState();
    },
    [clearTimer, flush, refreshSaveState, setLayoutList],
  );

  /** One-time import of Phase 3's per-symbol localStorage indicators into the active layout. */
  const migrate = useCallback(
    (loaded: ChartLayout[], active: EntityId) => {
      if (migrationStarted.current || isMigrated()) return;
      migrationStarted.current = true;
      const layout = loaded.find((l) => l.id === active);
      const legacy = layout && layout.indicators.length === 0 ? loadIndicators(layout.symbol) : [];
      if (!layout || legacy.length === 0) {
        retireLegacyIndicators();
        return;
      }
      edit({ indicators: legacy });
      // Delete the old copy only once the server has the new one.
      void flush(layout.id).then(() => {
        const now = layoutsRef.current.find((l) => l.id === layout.id);
        if (now && now.indicators.length > 0 && !failed.current.has(layout.id) && !pending.current.has(layout.id)) {
          retireLegacyIndicators();
        } else {
          migrationStarted.current = false; // try again on the next load
        }
      });
    },
    [edit, flush],
  );

  /**
   * Replace the layout list from the server WITHOUT leaving the 'ready' state, so the chart
   * is not remounted. Edits still waiting to be saved are laid back over their layouts: the
   * screen and the debounced PUT that follows must agree.
   */
  const refresh = useCallback(
    async (message: string) => {
      try {
        const fresh = await apiRequest<LayoutsResponse>('/layouts');
        const next = fresh.layouts.map((l) => {
          const patch = pending.current.get(l.id);
          return patch ? { ...l, ...patch } : l;
        });
        for (const id of [...pending.current.keys()]) if (!next.some((l) => l.id === id)) pending.current.delete(id);
        setLayoutList(next);
        if (!next.some((l) => l.id === activeIdRef.current)) setActive(fresh.activeLayoutId);
        refreshSaveState();
        setNotice(message);
      } catch (e) {
        setNotice(`${message} Could not refresh the list: ${messageOf(e)}`);
      }
    },
    [refreshSaveState, setActive, setLayoutList],
  );

  const load = useCallback(() => {
    const seq = (loadSeq.current += 1);
    statusRef.current = 'loading';
    setStatus('loading');
    apiRequest<LayoutsResponse>('/layouts').then(
      (res) => {
        if (seq !== loadSeq.current) return; // a newer load (StrictMode remount, Retry) owns the state
        setLayoutList(res.layouts);
        setActive(res.activeLayoutId);
        statusRef.current = 'ready';
        setStatus('ready');
        setLoadError(null);
        migrate(res.layouts, res.activeLayoutId);
        // What the user picked during "Loading layout…" wins over the stored values, per field.
        const early = loadingEdits.current;
        loadingEdits.current = {};
        if (Object.keys(early).length > 0) edit(early);
      },
      (e: unknown) => {
        if (seq !== loadSeq.current) return;
        statusRef.current = 'error';
        loadingEdits.current = {}; // the chart keeps working unsaved
        setStatus('error');
        setLoadError(messageOf(e));
      },
    );
  }, [edit, migrate, setActive, setLayoutList]);

  useEffect(() => {
    load();
    const timerMap = timers.current;
    // keepalive lets the request outlive the page, so an edit made just before closing still lands.
    // (An edit queued behind a PUT that is still in flight waits for it: the revision must be current.)
    const flushAll = (keepalive = false) => {
      for (const id of [...pending.current.keys()]) void flush(id, keepalive);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushAll(true);
    };
    const onPageHide = () => flushAll(true);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      loadSeq.current += 1;
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
      flushAll(); // do not lose the last edit when the provider goes away
    };
  }, [load, flush]);

  // ───────────────────────────── layout actions ─────────────────────────────

  const switchTo = useCallback(
    async (id: EntityId): Promise<ActionResult> => {
      const prev = activeIdRef.current;
      if (id === prev) return { ok: true };
      if (!layoutsRef.current.some((l) => l.id === id)) return { ok: false, message: 'That layout no longer exists.' };
      if (prev !== null) void flush(prev); // the old layout keeps saving in the background
      setActive(id);
      try {
        await apiRequest<Workspace>('/workspace/active', {
          method: 'PUT',
          body: { activeLayoutId: id },
        });
        return { ok: true };
      } catch (e) {
        const err = toDataError(e);
        if (activeIdRef.current === id) setActive(prev);
        const message = `Could not switch layout: ${messageOf(e)}`;
        setNotice(message);
        if (err.code === 'NOT_FOUND') void refresh('That layout no longer exists. The list is refreshed.');
        return { ok: false, message };
      }
    },
    [flush, refresh, setActive],
  );

  const addAndSwitch = useCallback(
    async (body: CreateLayoutBody): Promise<ActionResult> => {
      let created: ChartLayout;
      try {
        created = await apiRequest<ChartLayout>('/layouts', {
          method: 'POST',
          body,
        });
      } catch (e) {
        return { ok: false, message: messageOf(e) };
      }
      setLayoutList([...layoutsRef.current, created]);
      return switchTo(created.id);
    },
    [setLayoutList, switchTo],
  );

  const create = useCallback((name: string) => addAndSwitch({ name }), [addAndSwitch]);

  const duplicate = useCallback(
    (id: EntityId) => {
      const src = layoutsRef.current.find((l) => l.id === id);
      if (!src)
        return Promise.resolve<ActionResult>({
          ok: false,
          message: 'That layout no longer exists.',
        });
      // The local copy, so unsaved edits are included. The SAVED timeframe is copied, not the fallback.
      return addAndSwitch({
        name: copyName(src.name, layoutsRef.current),
        symbol: src.symbol,
        timeframe: src.timeframe,
        chartType: src.chartType,
        indicators: structuredClone(src.indicators),
      });
    },
    [addAndSwitch],
  );

  const rename = useCallback(
    (id: EntityId, name: string): Promise<ActionResult> =>
      enqueue(id, async (): Promise<ActionResult> => {
        await writePending(id); // settle edits first so the revision we send is current
        const layout = layoutsRef.current.find((l) => l.id === id);
        if (!layout) return { ok: false, message: 'That layout no longer exists.' };
        inflight.current += 1;
        refreshSaveState();
        try {
          const saved = await apiRequest<ChartLayout>(`/layouts/${id}`, {
            method: 'PUT',
            body: {
              revision: layout.revision,
              name,
            } satisfies UpdateLayoutBody,
          });
          setLayoutList(
            layoutsRef.current.map((l) =>
              l.id === id
                ? {
                    ...l,
                    name: saved.name,
                    revision: saved.revision,
                    updatedAt: saved.updatedAt,
                  }
                : l,
            ),
          );
          return { ok: true };
        } catch (e) {
          const err = toDataError(e);
          if (err.code === 'CONFLICT' || err.code === 'NOT_FOUND') {
            await adoptServer(
              id,
              err.code === 'CONFLICT'
                ? 'This layout was changed elsewhere, so it was not renamed. Showing the latest saved version.'
                : 'That layout no longer exists.',
            );
          }
          return { ok: false, message: messageOf(e) };
        } finally {
          inflight.current -= 1;
          refreshSaveState();
        }
      }),
    [adoptServer, enqueue, refreshSaveState, setLayoutList, writePending],
  );

  const remove = useCallback(
    async (id: EntityId): Promise<ActionResult> => {
      try {
        const ws = await apiRequest<Workspace>(`/layouts/${id}`, {
          method: 'DELETE',
        });
        clearTimer(id);
        pending.current.delete(id);
        failed.current.delete(id);
        const next = layoutsRef.current.filter((l) => l.id !== id);
        for (const l of ws.layouts) if (!next.some((x) => x.id === l.id)) next.push(l);
        setLayoutList(next);
        setActive(ws.activeLayoutId);
        refreshSaveState();
        return { ok: true };
      } catch (e) {
        if (toDataError(e).code === 'NOT_FOUND') {
          // Already deleted elsewhere: refetch so the stale entry goes away.
          const message = 'That layout was already deleted elsewhere. The list is refreshed.';
          void refresh(message);
          return { ok: false, message };
        }
        return { ok: false, message: messageOf(e) };
      }
    },
    [clearTimer, refresh, refreshSaveState, setActive, setLayoutList],
  );

  const retrySave = useCallback(() => {
    for (const id of [...failed.current]) {
      if (needsAdopt.current.has(id)) {
        // The server's answer to the refused edit never arrived: fetch it, do not "save" nothing.
        void adoptServer(id, 'Reloaded the latest saved version; your last edit was not saved.');
      } else {
        failed.current.delete(id);
        void flush(id);
      }
    }
    refreshSaveState();
  }, [adoptServer, flush, refreshSaveState]);

  // ───────────────────────────── context values ─────────────────────────────

  const active = layouts.find((l) => l.id === activeId);
  const chart: ActiveChart = active
    ? {
        layoutId: active.id,
        name: active.name,
        symbol: active.symbol,
        timeframe: active.timeframe,
        chartType: active.chartType,
        indicators: active.indicators,
      }
    : local;

  const chartApi = useMemo<ActiveChartApi>(
    () => ({
      chart,
      setSymbol: (symbol) => edit({ symbol }),
      setTimeframe: (timeframe) => edit({ timeframe }),
      setChartType: (chartType) => edit({ chartType }),
      setIndicators: (indicators) => edit({ indicators }),
    }),
    // `chart` is rebuilt every render; its fields are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chart.layoutId, chart.name, chart.symbol, chart.timeframe, chart.chartType, chart.indicators, edit],
  );

  const layoutList = useMemo(() => layouts.map((l) => ({ id: l.id, name: l.name })), [layouts]);
  const layoutsApi = useMemo<LayoutsApi>(
    () => ({
      status,
      loadError,
      layouts: layoutList,
      activeId,
      saveState,
      notice,
      dismissNotice: () => setNotice(null),
      reload: load,
      retrySave,
      switchTo,
      create,
      rename,
      duplicate,
      remove,
    }),
    [
      status,
      loadError,
      layoutList,
      activeId,
      saveState,
      notice,
      load,
      retrySave,
      switchTo,
      create,
      rename,
      duplicate,
      remove,
    ],
  );

  return (
    <LayoutsContext.Provider value={layoutsApi}>
      <ActiveChartContext.Provider value={chartApi}>{children}</ActiveChartContext.Provider>
    </LayoutsContext.Provider>
  );
}
