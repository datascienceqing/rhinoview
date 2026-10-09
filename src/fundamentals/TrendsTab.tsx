import { useState } from 'react';
import type { StatementPeriod } from '@shared/types';
import { useAsync } from '../data';
import { fetchOverview, fetchStatements } from './api';
import { AsyncBlock } from './AsyncBlock';
import { formatFraction, formatLarge, formatNumber } from './format';
import { PeriodToggle } from './StatementsTab';
import { TrendChart } from './TrendChart';
import { buildTrend } from './trends';
import type { TrendPoint } from './trends';

export function TrendsTab({ symbol }: { symbol: string }) {
  const [period, setPeriod] = useState<StatementPeriod>('annual');
  const state = useAsync(`trends:${symbol}:${period}`, async () => {
    const [income, cashflow, overview] = await Promise.all([
      fetchStatements(symbol, 'income', period),
      fetchStatements(symbol, 'cashflow', period),
      // The server says whether the gross margin means anything. Overview is shared with its tab.
      fetchOverview(symbol).catch(() => null),
    ]);
    return {
      points: buildTrend(income, cashflow),
      currency: income.rows[0]?.reportedCurrency ?? overview?.reportedCurrency ?? '',
      grossNotMeaningful: overview?.grossMarginNotMeaningful === true,
    };
  });
  return (
    <div className="fund-trends">
      <div className="fund-controls">
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>
      <AsyncBlock state={state} loading="Loading trends…">
        {(d) => <Charts points={d.points} currency={d.currency} grossNotMeaningful={d.grossNotMeaningful} />}
      </AsyncBlock>
    </div>
  );
}

function Charts({ points, currency, grossNotMeaningful }: { points: TrendPoint[]; currency: string; grossNotMeaningful: boolean }) {
  if (points.length === 0) return <p className="fund-unavailable">No periods reported.</p>;
  const labels = points.map((p) => p.label);
  const money = (v: number | null) => `${formatLarge(v)} ${currency}`.trim();
  return (
    <>
      <p className="fund-currency">Amounts in {currency || 'the reporting currency'}.</p>
      {grossNotMeaningful && (
        <p className="fund-currency" data-testid="gross-margin-note">
          Gross margin is not shown: the cost of revenue is mostly interest expense, so it is a lending spread.
        </p>
      )}
      <div className="fund-chart-grid">
        <TrendChart
          title="Revenue"
          kind="bar"
          labels={labels}
          format={money}
          series={[{ name: 'Revenue', color: 'var(--accent)', values: points.map((p) => p.revenue) }]}
        />
        <TrendChart
          title="Net income"
          kind="bar"
          labels={labels}
          format={money}
          series={[{ name: 'Net income', color: 'var(--accent)', values: points.map((p) => p.netIncome) }]}
        />
        <TrendChart
          title="EPS (diluted)"
          kind="bar"
          labels={labels}
          format={(v) => `${formatNumber(v)} ${currency}`.trim()}
          series={[{ name: 'EPS', color: 'var(--accent)', values: points.map((p) => p.eps) }]}
        />
        <TrendChart
          title="Margins"
          kind="line"
          labels={labels}
          format={formatFraction}
          series={[
            // A lender's gross margin is a lending spread: leave out only that line.
            ...(grossNotMeaningful
              ? []
              : [{ name: 'Gross', color: 'var(--accent)', values: points.map((p) => p.grossMargin) }]),
            { name: 'Operating', color: 'var(--up)', values: points.map((p) => p.operatingMargin) },
            { name: 'Net', color: 'var(--text-dim)', values: points.map((p) => p.netMargin) },
          ]}
        />
        <TrendChart
          title="Free cash flow"
          kind="bar"
          labels={labels}
          format={money}
          series={[{ name: 'Free cash flow', color: 'var(--accent)', values: points.map((p) => p.freeCashFlow) }]}
        />
      </div>
    </>
  );
}
