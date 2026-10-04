/**
 * Financials drawer below the chart. PHASE 5 SLOT — Worker W6 implements:
 * Overview, Statements, Trends and Earnings tabs for `symbol`.
 */
export interface FundamentalsDrawerProps {
  symbol: string;
  onClose: () => void;
}

export function FundamentalsDrawer({ symbol, onClose }: FundamentalsDrawerProps) {
  return (
    <section className="fundamentals-drawer" data-testid="fundamentals-drawer" aria-label={`Financials for ${symbol}`}>
      <header className="panel-header">
        Financials · {symbol}
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close financials">
          ×
        </button>
      </header>
    </section>
  );
}
