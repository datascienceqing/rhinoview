/**
 * React plumbing for the client workspace seam, plus the WAVE 0 in-memory provider.
 * W4 adds a persistent provider and switches the export in ./index.ts to it.
 */
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_ACTIVE_CHART } from './types';
import type { ActiveChart, ActiveChartApi } from './types';

export const ActiveChartContext = createContext<ActiveChartApi | null>(null);

export function useActiveChart(): ActiveChartApi {
  const api = useContext(ActiveChartContext);
  if (!api) throw new Error('useActiveChart must be used inside a WorkspaceProvider');
  return api;
}

/** Keeps the active chart in React state only. Nothing persists. Wave 0 placeholder. */
export function InMemoryWorkspaceProvider({
  children,
  initial = DEFAULT_ACTIVE_CHART,
}: {
  children: ReactNode;
  initial?: ActiveChart;
}) {
  const [chart, setChart] = useState<ActiveChart>(initial);
  const api = useMemo<ActiveChartApi>(
    () => ({
      chart,
      setSymbol: (symbol) => setChart((c) => ({ ...c, symbol })),
      setTimeframe: (timeframe) => setChart((c) => ({ ...c, timeframe })),
      setChartType: (chartType) => setChart((c) => ({ ...c, chartType })),
      setIndicators: (indicators) => setChart((c) => ({ ...c, indicators })),
    }),
    [chart],
  );
  return <ActiveChartContext.Provider value={api}>{children}</ActiveChartContext.Provider>;
}
