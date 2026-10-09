/**
 * Financials page: Overview, Statements, Trends and Earnings for `symbol`.
 *
 * A full page like TradingView's, not a strip under the chart: the shell places it over
 * the chart and the watchlist (see App.tsx), and the chart stays mounted underneath, so
 * it keeps its position when the page closes. The name is from when this was a drawer.
 *
 * Only the active tab is mounted, so a closed tab costs no request.
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { EarningsTab } from './EarningsTab';
import { OverviewTab } from './OverviewTab';
import { StatementsTab } from './StatementsTab';
import { TrendsTab } from './TrendsTab';
import './fundamentals.css';

export interface FundamentalsDrawerProps {
  symbol: string;
  onClose: () => void;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'statements', label: 'Statements' },
  { id: 'trends', label: 'Trends' },
  { id: 'earnings', label: 'Earnings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function FundamentalsDrawer({ symbol, onClose }: FundamentalsDrawerProps) {
  const [tab, setTab] = useState<TabId>('overview');
  const pageRef = useRef<HTMLElement>(null);

  // Focus moves into the page, so Esc and the keyboard work at once.
  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Only while focus is inside the page, and never when a control inside already used
    // the key (an open list closes on Esc first; the page closes on the next Esc).
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <section
      ref={pageRef}
      tabIndex={-1}
      className="fundamentals-page"
      data-testid="fundamentals-drawer"
      aria-label={`Financials for ${symbol}`}
      onKeyDown={onKeyDown}
    >
      <header className="fund-page-header">
        <button type="button" className="fund-back" onClick={onClose}>
          <span aria-hidden="true">← </span>Back to chart
        </button>
        <h2 className="fund-page-title">
          Financials <span className="fund-page-symbol">{symbol}</span>
        </h2>
        <span className="fund-page-hint">Esc closes this page</span>
      </header>
      <div className="fund-tabs" role="tablist" aria-label="Financials sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`fund-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="fund-tabpanel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="fund-body" role="tabpanel" id="fund-tabpanel" aria-labelledby={`fund-tab-${tab}`}>
        <div className="fund-body-inner">
          {tab === 'overview' && <OverviewTab symbol={symbol} />}
          {tab === 'statements' && <StatementsTab symbol={symbol} />}
          {tab === 'trends' && <TrendsTab symbol={symbol} />}
          {tab === 'earnings' && <EarningsTab symbol={symbol} />}
        </div>
      </div>
    </section>
  );
}
