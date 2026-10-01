import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChartType, SearchResult, Timeframe } from '@shared/types';
import { DataSourceProvider, HttpDataSource } from './data';
import type { DataSource } from './data';
import { ChartPanel, ChartTypeSelector, SnapshotReadout, SymbolSearch, TimeframeSelector } from './ui';

interface Selection {
  symbol: string;
  name: string | null;
}

const DEFAULT_SELECTION: Selection = { symbol: 'AAPL', name: null };

/**
 * Dev-only: serve /api/* from MSW (mocks/) instead of the proxy. On by default in
 * `vite dev`; set VITE_USE_MOCKS=false to talk to the real proxy. Never active in
 * tests (they install their own MSW server) or in production builds (the branch is
 * statically dead there, so MSW is not bundled).
 */
const USE_MOCKS =
  import.meta.env.DEV && import.meta.env.MODE !== 'test' && import.meta.env.VITE_USE_MOCKS !== 'false';

let mocksStarted: Promise<unknown> | null = null;
function startMocks(): Promise<unknown> {
  // Memoised: StrictMode runs the gate's effect twice and a second `start()` would warn.
  mocksStarted ??= import('../mocks/browser')
    .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass', quiet: true }))
    .catch((e: unknown) => {
      // Service workers can be unavailable (some embedded browsers, private modes).
      // Render anyway: requests then reach the Vite proxy, and every data path shows
      // its real error state instead of the app staying blank.
      console.warn('[mocks] MSW service worker failed to start; falling through to /api proxy.', e);
    });
  return mocksStarted;
}

/** Holds the app back until the service worker is ready, or the first requests would escape it. */
function MockGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!USE_MOCKS);
  useEffect(() => {
    if (!USE_MOCKS) return;
    let cancelled = false;
    startMocks().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready ? <>{children}</> : null;
}

export interface AppProps {
  /** Override the data source (tests, or a future WebSocket-backed one). */
  dataSource?: DataSource;
}

export function App({ dataSource }: AppProps) {
  const ds = useMemo(() => dataSource ?? new HttpDataSource(), [dataSource]);
  return (
    <MockGate>
      <DataSourceProvider value={ds}>
        <Shell />
      </DataSourceProvider>
    </MockGate>
  );
}

function Shell() {
  const [selection, setSelection] = useState<Selection>(DEFAULT_SELECTION);
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [chartType, setChartType] = useState<ChartType>('candlestick');

  function select(result: SearchResult) {
    setSelection({ symbol: result.symbol, name: result.name });
  }

  return (
    <div className="app-shell">
      <header className="toolbar">
        <SymbolSearch onSelect={select} />
        <SnapshotReadout symbol={selection.symbol} name={selection.name} />
        <div className="toolbar-spacer" />
        <TimeframeSelector value={timeframe} onChange={setTimeframe} />
        <ChartTypeSelector value={chartType} onChange={setChartType} />
      </header>
      {/* Column layout: the chart takes the remaining height, so an indicator pane
          can later be added as a sibling without reworking the shell. */}
      <main className="workspace">
        <ChartPanel symbol={selection.symbol} timeframe={timeframe} chartType={chartType} />
      </main>
    </div>
  );
}
