/**
 * Watchlist panel in the right sidebar. PHASE 5 SLOT — Worker W5 implements.
 * W5 may depend on `useActiveChart()` from ../workspace and `apiRequest` from ../data,
 * and on nothing else outside src/watchlist/.
 */
export function WatchlistPanel() {
  return (
    <section className="watchlist-panel" data-testid="watchlist-panel" aria-label="Watchlist">
      <header className="panel-header">Watchlist</header>
    </section>
  );
}
