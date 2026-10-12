/**
 * Financials page: Overview, Statements, Trends, Earnings and News for `symbol`.
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
import { NewsTab } from './NewsTab';
import { OverviewTab } from './OverviewTab';
import { StatementsTab } from './StatementsTab';
import { TrendsTab } from './TrendsTab';
import './fundamentals.css';
import { useI18n } from '../i18n';

export interface FundamentalsDrawerProps {
  symbol: string;
  onClose: () => void;
}

const TABS = ['overview', 'statements', 'trends', 'earnings', 'news'] as const;
type TabId = (typeof TABS)[number];

export function FundamentalsDrawer({ symbol, onClose }: FundamentalsDrawerProps) {
  const { t } = useI18n();
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
      aria-label={t('fund.page', { symbol })}
      onKeyDown={onKeyDown}
    >
      <header className="fund-page-header">
        <button type="button" className="fund-back" onClick={onClose}>
          <span aria-hidden="true">← </span>
          {t('fund.back')}
        </button>
        <h2 className="fund-page-title">
          {t('fund.title')} <span className="fund-page-symbol">{symbol}</span>
        </h2>
        <span className="fund-page-hint">{t('fund.escHint')}</span>
      </header>
      <div className="fund-tabs" role="tablist" aria-label={t('fund.sections')}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`fund-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="fund-tabpanel"
            onClick={() => setTab(id)}
          >
            {t(`fund.tab.${id}`)}
          </button>
        ))}
      </div>
      <div className="fund-body" role="tabpanel" id="fund-tabpanel" aria-labelledby={`fund-tab-${tab}`}>
        <div className="fund-body-inner">
          {tab === 'overview' && <OverviewTab symbol={symbol} />}
          {tab === 'statements' && <StatementsTab symbol={symbol} />}
          {tab === 'trends' && <TrendsTab symbol={symbol} />}
          {tab === 'earnings' && <EarningsTab symbol={symbol} />}
          {tab === 'news' && <NewsTab symbol={symbol} />}
        </div>
      </div>
    </section>
  );
}
