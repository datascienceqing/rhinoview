/**
 * Financials drawer below the chart: Overview, Statements, Trends and Earnings for `symbol`.
 * Only the active tab is mounted, so a closed tab costs no request.
 */
import { useState } from 'react';
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
  return (
    <section className="fundamentals-drawer" data-testid="fundamentals-drawer" aria-label={`Financials for ${symbol}`}>
      <header className="panel-header">
        Financials · {symbol}
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close financials">
          ×
        </button>
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
        {tab === 'overview' && <OverviewTab symbol={symbol} />}
        {tab === 'statements' && <StatementsTab symbol={symbol} />}
        {tab === 'trends' && <TrendsTab symbol={symbol} />}
        {tab === 'earnings' && <EarningsTab symbol={symbol} />}
      </div>
    </section>
  );
}
