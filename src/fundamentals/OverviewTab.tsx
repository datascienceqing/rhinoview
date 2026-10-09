import type { AnalystConsensus, FinancialScores, FundamentalsOverview, KeyMetricsTTM } from '@shared/types';
import { useAsync, useDataSource } from '../data';
import { fetchOverview } from './api';
import { AsyncBlock } from './AsyncBlock';
import {
  DASH,
  formatFraction,
  formatLarge,
  formatNumber,
  isFinancialSector,
  marginCell,
  multipleCell,
} from './format';
import type { Cell } from './format';

type Kind = 'multiple' | 'margin' | 'fraction' | 'ratio' | 'perShare';
interface MetricRow {
  label: string;
  /** Tooltip on the label, for metrics whose name could be confused with another figure. */
  hint?: string;
  key: keyof KeyMetricsTTM;
  kind: Kind;
}
interface Group {
  title: string;
  rows: MetricRow[];
}

const GROUPS: Group[] = [
  {
    title: 'Valuation',
    rows: [
      { label: 'P/E', key: 'peRatio', kind: 'multiple' },
      { label: 'PEG', key: 'pegRatio', kind: 'multiple' },
      { label: 'EV/EBITDA', key: 'evToEbitda', kind: 'multiple' },
      { label: 'P/S', key: 'priceToSales', kind: 'multiple' },
      { label: 'P/B', key: 'priceToBook', kind: 'multiple' },
    ],
  },
  {
    title: 'Profitability',
    rows: [
      { label: 'Gross margin', key: 'grossMargin', kind: 'margin' },
      { label: 'Operating margin', key: 'operatingMargin', kind: 'margin' },
      { label: 'Net margin', key: 'netMargin', kind: 'margin' },
      { label: 'Return on equity', key: 'returnOnEquity', kind: 'fraction' },
      { label: 'Return on assets', key: 'returnOnAssets', kind: 'fraction' },
      { label: 'Return on invested capital', key: 'returnOnInvestedCapital', kind: 'fraction' },
    ],
  },
  {
    title: 'Financial health',
    rows: [
      { label: 'Debt / equity', key: 'debtToEquity', kind: 'ratio' },
      { label: 'Current ratio', key: 'currentRatio', kind: 'ratio' },
      { label: 'Interest coverage', key: 'interestCoverage', kind: 'ratio' },
    ],
  },
  {
    title: 'Per share',
    rows: [
      { label: 'EPS (TTM)', key: 'epsDiluted', kind: 'perShare', hint: 'Net income per share, trailing twelve months' },
      { label: 'Revenue / share', key: 'revenuePerShare', kind: 'perShare' },
      { label: 'Free cash flow / share', key: 'freeCashFlowPerShare', kind: 'perShare' },
      { label: 'Book value / share', key: 'bookValuePerShare', kind: 'perShare' },
    ],
  },
  {
    title: 'Dividend',
    rows: [
      { label: 'Dividend yield', key: 'dividendYield', kind: 'fraction' },
      { label: 'Payout ratio', key: 'payoutRatio', kind: 'fraction' },
    ],
  },
];

function metricCell(row: MetricRow, value: number | null, financial: boolean): Cell {
  switch (row.kind) {
    case 'multiple':
      return multipleCell(value);
    case 'margin':
      return marginCell(value, financial);
    case 'fraction':
      return { text: formatFraction(value) };
    default:
      return { text: formatNumber(value) };
  }
}

export function OverviewTab({ symbol }: { symbol: string }) {
  const state = useAsync(`overview:${symbol}`, () => fetchOverview(symbol));
  return (
    <AsyncBlock state={state} loading="Loading overview…">
      {(o) => <OverviewBody overview={o} />}
    </AsyncBlock>
  );
}

function NotAvailable({ what }: { what: string }) {
  return (
    <p className="fund-unavailable" data-testid={`unavailable-${what}`}>
      Not available
    </p>
  );
}

function OverviewBody({ overview: o }: { overview: FundamentalsOverview }) {
  const financial = isFinancialSector(o.profile.sector);
  const gone = (s: 'metrics' | 'scores' | 'analyst') => o.unavailable.includes(s);
  return (
    <div className="fund-overview">
      <section className="fund-card fund-profile" aria-label="Company profile">
        <h3>{o.profile.name}</h3>
        <dl className="fund-facts">
          <Fact label="Sector" value={o.profile.sector} />
          <Fact label="Industry" value={o.profile.industry} />
          <Fact label="Exchange" value={o.profile.exchange} />
          <Fact label="Country" value={o.profile.country} />
          <Fact label="CEO" value={o.profile.ceo} />
          <Fact label="Employees" value={o.profile.employees === null ? null : formatNumber(o.profile.employees, 0)} />
          <Fact label="IPO" value={o.profile.ipoDate} />
          <Fact
            label="Market cap"
            value={o.profile.marketCap === null ? null : `${formatLarge(o.profile.marketCap)} ${o.profile.currency}`}
          />
          <Fact label="Reports in" value={o.reportedCurrency} />
        </dl>
        {o.profile.description && <p className="fund-description">{o.profile.description}</p>}
      </section>

      <section className="fund-card fund-metrics" aria-label="Key metrics">
        <h3>Key metrics (trailing twelve months)</h3>
        {gone('metrics') ? (
          <NotAvailable what="metrics" />
        ) : (
          <div className="fund-groups">
            {GROUPS.map((g) => (
              <div key={g.title} className="fund-group">
                <h4>{g.title === 'Per share' ? `Per share (${o.reportedCurrency})` : g.title}</h4>
                <dl className="fund-facts">
                  {g.rows.map((row) => {
                    const cell = metricCell(row, o.metrics[row.key], financial);
                    return (
                      <div key={row.key} className="fund-fact">
                        <dt title={row.hint}>{row.label}</dt>
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

      <section className="fund-card" aria-label="Financial scores">
        <h3>Scores</h3>
        {gone('scores') ? <NotAvailable what="scores" /> : <Scores scores={o.scores} />}
      </section>

      <section className="fund-card" aria-label="Analyst consensus">
        <h3>Analyst consensus</h3>
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
  return (
    <dl className="fund-facts">
      <div className="fund-fact">
        <dt>Piotroski F-score (0–9)</dt>
        <dd data-testid="piotroski">{scores.piotroskiScore === null ? DASH : String(scores.piotroskiScore)}</dd>
      </div>
      <div className="fund-fact">
        <dt>Altman Z-score</dt>
        <dd data-testid="altman">{formatNumber(scores.altmanZScore)}</dd>
      </div>
    </dl>
  );
}

function Analysts({ analyst: a, symbol }: { analyst: AnalystConsensus; symbol: string }) {
  const ds = useDataSource();
  const snapshot = useAsync(`price:${symbol}`, (signal) => ds.getSnapshot(symbol, { signal }));
  const price = snapshot.status === 'success' ? snapshot.data.price : null;
  const counts: [string, number | null][] = [
    ['Strong buy', a.strongBuy],
    ['Buy', a.buy],
    ['Hold', a.hold],
    ['Sell', a.sell],
    ['Strong sell', a.strongSell],
  ];
  return (
    <div className="fund-analyst">
      <p className="fund-consensus" data-testid="consensus">
        {a.consensus ?? DASH}
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
  const { low, high, consensus, median, price } = props;
  const pos = (v: number | null): number | null =>
    v === null || low === null || high === null || high <= low ? null : Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100));
  const pricePos = pos(price);
  const outside = price !== null && low !== null && high !== null ? (price < low ? 'below' : price > high ? 'above' : null) : null;
  return (
    <div className="fund-target" data-testid="target-range">
      <div className="fund-target-labels">
        <span>Low {formatNumber(low)}</span>
        <span>Consensus {formatNumber(consensus)}</span>
        <span>Median {formatNumber(median)}</span>
        <span>High {formatNumber(high)}</span>
      </div>
      <div className="fund-target-bar" role="img" aria-label={`Price target range ${formatNumber(low)} to ${formatNumber(high)}, current price ${formatNumber(price)}`}>
        {pos(consensus) !== null && <span className="fund-target-tick" style={{ left: `${pos(consensus)}%` }} />}
        {pricePos !== null && <span className="fund-target-price" style={{ left: `${pricePos}%` }} />}
      </div>
      <p className="fund-target-note">
        Current price {formatNumber(price)}
        {outside ? ` (${outside} the target range)` : ''}
      </p>
    </div>
  );
}
