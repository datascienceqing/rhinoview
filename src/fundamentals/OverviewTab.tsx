import type { AnalystConsensus, FinancialScores, FundamentalsOverview, KeyMetricsTTM } from '@shared/types';
import { useAsync, useDataSource } from '../data';
import { fetchOverview } from './api';
import { AsyncBlock } from './AsyncBlock';
import {
  DASH,
  formatFraction,
  formatLarge,
  formatNumber,
  marginCell,
  multipleCell,
} from './format';
import type { Cell } from './format';
import { t, useI18n } from '../i18n';
import type { MessageKey } from '../i18n';

type Kind = 'multiple' | 'margin' | 'fraction' | 'ratio' | 'perShare';
/** The label is `fund.metric.<key>`; a `hint` is `fund.metric.<key>.hint`. */
interface MetricRow {
  /** Tooltip on the label, for metrics whose name could be confused with another figure. */
  hint?: true;
  key: keyof KeyMetricsTTM;
  kind: Kind;
}
interface Group {
  id: 'valuation' | 'profitability' | 'health' | 'perShare' | 'dividend';
  rows: MetricRow[];
}

const GROUPS: Group[] = [
  {
    id: 'valuation',
    rows: [
      { key: 'peRatio', kind: 'multiple' },
      { key: 'pegRatio', kind: 'multiple' },
      { key: 'evToEbitda', kind: 'multiple' },
      { key: 'priceToSales', kind: 'multiple' },
      { key: 'priceToBook', kind: 'multiple' },
    ],
  },
  {
    id: 'profitability',
    rows: [
      { key: 'grossMargin', kind: 'margin' },
      { key: 'operatingMargin', kind: 'margin' },
      { key: 'netMargin', kind: 'margin' },
      { key: 'returnOnEquity', kind: 'fraction' },
      { key: 'returnOnAssets', kind: 'fraction' },
      { key: 'returnOnInvestedCapital', kind: 'fraction' },
    ],
  },
  {
    id: 'health',
    rows: [
      { key: 'debtToEquity', kind: 'ratio' },
      { key: 'currentRatio', kind: 'ratio' },
      { key: 'interestCoverage', kind: 'ratio' },
    ],
  },
  {
    id: 'perShare',
    rows: [
      { key: 'epsDiluted', kind: 'perShare', hint: true },
      { key: 'revenuePerShare', kind: 'perShare' },
      { key: 'freeCashFlowPerShare', kind: 'perShare' },
      { key: 'bookValuePerShare', kind: 'perShare' },
    ],
  },
  {
    id: 'dividend',
    rows: [
      { key: 'dividendYield', kind: 'fraction' },
      { key: 'payoutRatio', kind: 'fraction' },
    ],
  },
];

function metricCell(row: MetricRow, value: number | null, grossNotMeaningful: boolean): Cell {
  switch (row.kind) {
    case 'multiple':
      return multipleCell(value);
    case 'margin':
      return marginCell(value, row.key === 'grossMargin' && grossNotMeaningful);
    case 'fraction':
      return { text: formatFraction(value) };
    default:
      return { text: formatNumber(value) };
  }
}

export function OverviewTab({ symbol }: { symbol: string }) {
  const { t } = useI18n();
  const state = useAsync(`overview:${symbol}`, () => fetchOverview(symbol));
  return (
    <AsyncBlock state={state} loading={t('fund.loadingOverview')}>
      {(o) => <OverviewBody overview={o} />}
    </AsyncBlock>
  );
}

function NotAvailable({ what }: { what: string }) {
  const { t } = useI18n();
  return (
    <p className="fund-unavailable" data-testid={`unavailable-${what}`}>
      {t('fund.notAvailable')}
    </p>
  );
}

function OverviewBody({ overview: o }: { overview: FundamentalsOverview }) {
  const { t } = useI18n();
  const grossNotMeaningful = o.grossMarginNotMeaningful;
  const gone = (s: 'metrics' | 'scores' | 'analyst') => o.unavailable.includes(s);
  return (
    <div className="fund-overview">
      <section className="fund-card fund-profile" aria-label={t('fund.profile')}>
        <h3>{o.profile.name}</h3>
        <dl className="fund-facts">
          <Fact label={t('fund.fact.sector')} value={o.profile.sector} />
          <Fact label={t('fund.fact.industry')} value={o.profile.industry} />
          <Fact label={t('fund.fact.exchange')} value={o.profile.exchange} />
          <Fact label={t('fund.fact.country')} value={o.profile.country} />
          <Fact label={t('fund.fact.ceo')} value={o.profile.ceo} />
          <Fact label={t('fund.fact.employees')} value={o.profile.employees === null ? null : formatNumber(o.profile.employees, 0)} />
          <Fact label={t('fund.fact.ipo')} value={o.profile.ipoDate} />
          <Fact
            label={t('fund.fact.marketCap')}
            value={o.profile.marketCap === null ? null : `${formatLarge(o.profile.marketCap)} ${o.profile.currency}`}
          />
          <Fact label={t('fund.fact.reportsIn')} value={o.reportedCurrency} />
        </dl>
        {o.profile.description && <p className="fund-description">{o.profile.description}</p>}
      </section>

      <section className="fund-card fund-metrics" aria-label={t('fund.keyMetrics')}>
        <h3>{t('fund.keyMetricsTitle')}</h3>
        {gone('metrics') ? (
          <NotAvailable what="metrics" />
        ) : (
          <div className="fund-groups">
            {GROUPS.map((g) => (
              <div key={g.id} className="fund-group">
                <h4>{g.id === 'perShare' ? t('fund.group.perShare', { currency: o.reportedCurrency }) : t(`fund.group.${g.id}`)}</h4>
                <dl className="fund-facts">
                  {g.rows.map((row) => {
                    const cell = metricCell(row, o.metrics[row.key], grossNotMeaningful);
                    return (
                      <div key={row.key} className="fund-fact">
                        <dt title={row.hint ? t(`fund.metric.${row.key}.hint` as 'fund.metric.epsDiluted.hint') : undefined}>
                          {t(`fund.metric.${row.key}`)}
                        </dt>
                        <dd title={cell.title} data-testid={`metric-${row.key}`}>
                          {cell.text}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="fund-card" aria-label={t('fund.scoresLabel')}>
        <h3>{t('fund.scores')}</h3>
        {gone('scores') ? <NotAvailable what="scores" /> : <Scores scores={o.scores} />}
      </section>

      <section className="fund-card" aria-label={t('fund.analyst')}>
        <h3>{t('fund.analyst')}</h3>
        {gone('analyst') ? <NotAvailable what="analyst" /> : <Analysts analyst={o.analyst} symbol={o.profile.symbol} />}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="fund-fact">
      <dt>{label}</dt>
      <dd>{value ?? DASH}</dd>
    </div>
  );
}

function Scores({ scores }: { scores: FinancialScores }) {
  const { t } = useI18n();
  return (
    <dl className="fund-facts">
      <div className="fund-fact">
        <dt>{t('fund.piotroski')}</dt>
        <dd data-testid="piotroski">{scores.piotroskiScore === null ? DASH : String(scores.piotroskiScore)}</dd>
      </div>
      <div className="fund-fact">
        <dt>{t('fund.altman')}</dt>
        <dd data-testid="altman">{formatNumber(scores.altmanZScore)}</dd>
      </div>
    </dl>
  );
}

/** The provider's consensus label in the current language; an unknown label is shown as it is. */
function consensusLabel(label: string | null): string {
  if (label === null) return DASH;
  const key = RATING_KEYS[label.toLowerCase().replace(/\s+/g, '')];
  return key ? t(key) : label;
}
const RATING_KEYS: Record<string, MessageKey> = {
  strongbuy: 'fund.rating.strongBuy',
  buy: 'fund.rating.buy',
  hold: 'fund.rating.hold',
  sell: 'fund.rating.sell',
  strongsell: 'fund.rating.strongSell',
};

function Analysts({ analyst: a, symbol }: { analyst: AnalystConsensus; symbol: string }) {
  useI18n(); // a new language renders the labels again
  const ds = useDataSource();
  const snapshot = useAsync(`price:${symbol}`, (signal) => ds.getSnapshot(symbol, { signal }));
  const price = snapshot.status === 'success' ? snapshot.data.price : null;
  const counts: [string, number | null][] = [
    [t('fund.rating.strongBuy'), a.strongBuy],
    [t('fund.rating.buy'), a.buy],
    [t('fund.rating.hold'), a.hold],
    [t('fund.rating.sell'), a.sell],
    [t('fund.rating.strongSell'), a.strongSell],
  ];
  return (
    <div className="fund-analyst">
      <p className="fund-consensus" data-testid="consensus">
        {consensusLabel(a.consensus)}
      </p>
      <ul className="fund-counts">
        {counts.map(([label, n]) => (
          <li key={label}>
            {label}: <strong>{n ?? DASH}</strong>
          </li>
        ))}
      </ul>
      <TargetRange low={a.targetLow} high={a.targetHigh} consensus={a.targetConsensus} median={a.targetMedian} price={price} />
    </div>
  );
}

function TargetRange(props: {
  low: number | null;
  high: number | null;
  consensus: number | null;
  median: number | null;
  price: number | null;
}) {
  const { t } = useI18n();
  const { low, high, consensus, median, price } = props;
  const pos = (v: number | null): number | null =>
    v === null || low === null || high === null || high <= low ? null : Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100));
  const pricePos = pos(price);
  const outside = price !== null && low !== null && high !== null ? (price < low ? 'below' : price > high ? 'above' : null) : null;
  return (
    <div className="fund-target" data-testid="target-range">
      <div className="fund-target-labels">
        <span>{t('fund.target.low', { value: formatNumber(low) })}</span>
        <span>{t('fund.target.consensus', { value: formatNumber(consensus) })}</span>
        <span>{t('fund.target.median', { value: formatNumber(median) })}</span>
        <span>{t('fund.target.high', { value: formatNumber(high) })}</span>
      </div>
      <div className="fund-target-bar" role="img" aria-label={t('fund.target.bar', { low: formatNumber(low), high: formatNumber(high), price: formatNumber(price) })}>
        {pos(consensus) !== null && <span className="fund-target-tick" style={{ left: `${pos(consensus)}%` }} />}
        {pricePos !== null && <span className="fund-target-price" style={{ left: `${pricePos}%` }} />}
      </div>
      <p className="fund-target-note">
        {t('fund.target.price', { price: formatNumber(price) })}
        {outside === 'below' ? t('fund.target.below') : outside === 'above' ? t('fund.target.above') : ''}
      </p>
    </div>
  );
}
