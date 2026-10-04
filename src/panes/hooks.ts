import { useCallback, useMemo, useRef } from 'react';
import type { Bar, IndicatorConfig, IndicatorKind, IndicatorParams } from '@shared/types';
import type { ComputeIndicator } from '../indicators/types';
import { ComputeCache } from './computeCache';
import type { ComputedIndicator } from './computeCache';
import { computeIndicator } from './computeSource';
import { createIndicator } from './config';

export interface IndicatorActions {
  indicators: readonly IndicatorConfig[];
  add(kind: IndicatorKind): void;
  remove(id: string): void;
  setParams(id: string, params: IndicatorParams): void;
  setColor(id: string, color: string): void;
  setVisible(id: string, visible: boolean): void;
}

/**
 * Editing actions over a CONTROLLED list of indicators. The list belongs to the active
 * layout (see src/workspace), which also persists it; this hook only turns user actions
 * into new lists.
 */
export function useIndicators(
  indicators: readonly IndicatorConfig[],
  setIndicators: (next: IndicatorConfig[]) => void,
): IndicatorActions {
  // Latest list for the action callbacks, so a burst of slider events composes instead of racing.
  const latest = useRef<readonly IndicatorConfig[]>(indicators);
  latest.current = indicators;

  const commit = useCallback(
    (change: (items: readonly IndicatorConfig[]) => IndicatorConfig[]) => {
      const next = change(latest.current);
      latest.current = next;
      setIndicators(next);
    },
    [setIndicators],
  );

  const patch = useCallback(
    (id: string, change: Partial<IndicatorConfig>) =>
      commit((items) => items.map((c) => (c.id === id ? { ...c, ...change } : c))),
    [commit],
  );

  return useMemo(
    () => ({
      indicators,
      add: (kind) => commit((items) => [...items, createIndicator(kind, items)]),
      remove: (id) => commit((items) => items.filter((c) => c.id !== id)),
      setParams: (id, params) => patch(id, { params }),
      setColor: (id, color) => patch(id, { color }),
      setVisible: (id, visible) => patch(id, { visible }),
    }),
    [indicators, commit, patch],
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
