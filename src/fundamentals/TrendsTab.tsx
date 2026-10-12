import { useState } from 'react';
import type { StatementPeriod } from '@shared/types';
import { useAsync } from '../data';
import { fetchOverview, fetchStatements } from './api';
import { AsyncBlock } from './AsyncBlock';
import { formatFraction, formatFractionTick, formatLarge, formatLargeTick, formatNumber, formatTick } from './format';
import { PeriodToggle } from './StatementsTab';
import { TrendChart } from './TrendChart';
import { buildTrend } from './trends';
import type { TrendPoint } from './trends';
import { useI18n } from '../i18n';

export function TrendsTab({ symbol }: { symbol: string }) {
  const { t } = useI18n();
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
      <AsyncBlock state={state} loading={t('fund.loadingTrends')}>
        {(d) => <Charts points={d.points} currency={d.currency} grossNotMeaningful={d.grossNotMeaningful} />}
      </AsyncBlock>
    </div>
  );
}

function Charts({ points, currency, grossNotMeaningful }: { points: TrendPoint[]; currency: string; grossNotMeaningful: boolean }) {
  const { t } = useI18n();
  if (points.length === 0) return <p className="fund-unavailable">{t('fund.noPeriods')}</p>;
  const labels = points.map((p) => p.label);
  const money = (v: number | null) => `${formatLarge(v)} ${currency}`.trim();
  return (
    <>
      <p className="fund-currency">{t('fund.amountsIn', { currency: currency || t('fund.reportingCurrency') })}</p>
      {grossNotMeaningful && (
        <p className="fund-currency" data-testid="gross-margin-note">
          {t('fund.grossHidden')}
        </p>
      )}
      <div className="fund-chart-grid">
        <TrendChart
          id="Revenue"
          title={t('fund.chart.revenue')}
          kind="bar"
          labels={labels}
          format={money}
          tick={formatLargeTick}
          series={[{ name: t('fund.chart.revenue'), color: 'var(--accent)', values: points.map((p) => p.revenue) }]}
        />
        <TrendChart
          id="Net income"
          title={t('fund.chart.netIncome')}
          kind="bar"
          labels={labels}
          format={money}
          tick={formatLargeTick}
          series={[{ name: t('fund.chart.netIncome'), color: 'var(--accent)', values: points.map((p) => p.netIncome) }]}
        />
        <TrendChart
          id="EPS (diluted)"
          title={t('fund.chart.eps')}
          kind="bar"
          labels={labels}
          format={(v) => `${formatNumber(v)} ${currency}`.trim()}
          tick={formatTick}
          series={[{ name: t('fund.chart.epsSeries'), color: 'var(--accent)', values: points.map((p) => p.eps) }]}
        />
        <TrendChart
          id="Margins"
          title={t('fund.chart.margins')}
          kind="line"
          labels={labels}
          format={formatFraction}
          tick={formatFractionTick}
          series={[
            // A lender's gross margin is a lending spread: leave out only that line.
            ...(grossNotMeaningful
              ? []
              : [{ name: t('fund.chart.gross'), color: 'var(--accent)', values: points.map((p) => p.grossMargin) }]),
            // A fixed colour: --up swaps with the language, and this line is not a direction.
            { name: t('fund.chart.operating'), color: 'var(--warn)', values: points.map((p) => p.operatingMargin) },
            { name: t('fund.chart.net'), color: 'var(--text-dim)', values: points.map((p) => p.netMargin) },
          ]}
        />
        <TrendChart
          id="Free cash flow"
          title={t('fund.chart.fcf')}
          kind="bar"
          labels={labels}
          format={money}
          tick={formatLargeTick}
          series={[{ name: t('fund.chart.fcf'), color: 'var(--accent)', values: points.map((p) => p.freeCashFlow) }]}
        />
      </div>
    </>
  );
}
