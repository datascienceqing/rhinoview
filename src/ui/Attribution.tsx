/**
 * Licence-required attribution for TradingView Lightweight Charts.
 *
 * The library's on-chart logo is disabled (`layout.attributionLogo: false` in
 * `src/chart/PriceChart.ts`). The licence permits that ONLY when the linking
 * requirement is met another way, and this component is that other way: a link to
 * https://www.tradingview.com/ on a page available to users.
 *
 * Do not delete this without re-enabling the on-chart logo. See NOTICE at the repo root.
 */
export function Attribution() {
  return (
    <footer className="attribution">
      Charts powered by{' '}
      <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
        TradingView Lightweight Charts™
      </a>
    </footer>
  );
}
