import { useCallback, useMemo, useRef, useState } from 'react';
import type { Bar, IndicatorConfig, IndicatorKind, IndicatorParams } from '@shared/types';
import type { ComputeIndicator } from '../indicators/types';
import { ComputeCache } from './computeCache';
import type { ComputedIndicator } from './computeCache';
import { computeIndicator } from './computeSource';
import { createIndicator } from './config';
import { loadIndicators, saveIndicators } from './storage';
import type { StorageLike } from './storage';

export interface IndicatorActions {
  indicators: IndicatorConfig[];
  add(kind: IndicatorKind): void;
  remove(id: string): void;
  setParams(id: string, params: IndicatorParams): void;
  setColor(id: string, color: string): void;
  setVisible(id: string, visible: boolean): void;
}

interface Held {
  symbol: string;
  items: IndicatorConfig[];
}

/**
 * The user's indicators for `symbol`, persisted per symbol. Persistence is best effort
 * (see storage.ts): a failure leaves the in-memory state, and the chart, untouched.
 */
export function useIndicators(symbol: string, storage?: StorageLike): IndicatorActions {
  const [held, setHeld] = useState<Held>(() => ({ symbol, items: loadIndicators(symbol, storage) }));
  // Latest state for the action callbacks, so a burst of slider events composes instead of racing.
  const latest = useRef(held);

  let current = held;
  if (held.symbol !== symbol) {
    // Symbol changed: swap in that symbol's saved list during render (React's
    // "adjust state when a prop changes" pattern), so no frame draws the old symbol's indicators.
    current = { symbol, items: loadIndicators(symbol, storage) };
    latest.current = current;
    setHeld(current);
  }

  const commit = useCallback(
    (change: (items: IndicatorConfig[]) => IndicatorConfig[]) => {
      const next = { symbol: latest.current.symbol, items: change(latest.current.items) };
      latest.current = next;
      setHeld(next);
      saveIndicators(next.symbol, next.items, storage);
    },
    [storage],
  );

  const patch = useCallback(
    (id: string, change: Partial<IndicatorConfig>) =>
      commit((items) => items.map((c) => (c.id === id ? { ...c, ...change } : c))),
    [commit],
  );

  return useMemo(
    () => ({
      indicators: current.items,
      add: (kind) => commit((items) => [...items, createIndicator(kind, items)]),
      remove: (id) => commit((items) => items.filter((c) => c.id !== id)),
      setParams: (id, params) => patch(id, { params }),
      setColor: (id, color) => patch(id, { color }),
      setVisible: (id, visible) => patch(id, { visible }),
    }),
    [current.items, commit, patch],
  );
}

/** Indicator series for the current bars; only what changed is recomputed (see ComputeCache). */
export function useComputedIndicators(
  bars: readonly Bar[],
  configs: readonly IndicatorConfig[],
  compute: ComputeIndicator = computeIndicator,
): ComputedIndicator[] {
  const cache = useMemo(() => new ComputeCache(compute), [compute]);
  return useMemo(() => cache.resolve(bars, configs), [cache, bars, configs]);
}
