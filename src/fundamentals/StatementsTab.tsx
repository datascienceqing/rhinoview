import { useState } from 'react';
import type { StatementKind, StatementPeriod, StatementsResponse } from '@shared/types';
import { useAsync } from '../data';
import { fetchStatements } from './api';
import { AsyncBlock } from './AsyncBlock';
import { DASH, fiscalLabel, formatLarge, formatNumber } from './format';
import { t as translate, useI18n } from '../i18n';
import { lineLabel } from './lineLabels';

const KINDS: readonly StatementKind[] = ['income', 'balance', 'cashflow'];

export function PeriodToggle({ value, onChange }: { value: StatementPeriod; onChange: (p: StatementPeriod) => void }) {
  const { t } = useI18n();
  return (
    <div className="fund-seg" role="group" aria-label={t('fund.period')}>
      {(['annual', 'quarter'] as const).map((p) => (
        <button key={p} type="button" aria-pressed={value === p} onClick={() => onChange(p)}>
          {p === 'annual' ? t('fund.annual') : t('fund.quarterly')}
        </button>
      ))}
    </div>
  );
}

/** Per-share and count lines are not money in the B/M sense. */
const isPerShare = (key: string) => /^eps/i.test(key);
/** Share counts are quantities, not money: they get a "shares" unit and no currency. */
const isShareCount = (key: string) => /shsout|shares/i.test(key);

function formatCell(key: string, v: number | null): string {
  if (v === null) return DASH;
  if (isPerShare(key)) return formatNumber(v);
  if (isShareCount(key)) return translate('fund.shares', { value: formatLarge(v) });
  return formatLarge(v);
}

export function StatementsTab({ symbol }: { symbol: string }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<StatementKind>('income');
  const [period, setPeriod] = useState<StatementPeriod>('annual');
  const state = useAsync(`statements:${symbol}:${kind}:${period}`, () => fetchStatements(symbol, kind, period));
  return (
    <div className="fund-statements">
      <div className="fund-controls">
        <div className="fund-seg" role="group" aria-label={t('fund.statement')}>
          {KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(`fund.stmt.${k}`)}
            </button>
          ))}
        </div>
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>
      <AsyncBlock state={state} loading={t('fund.loadingStatements')}>
        {(s) => <StatementTable data={s} />}
      </AsyncBlock>
    </div>
  );
}

function StatementTable({ data }: { data: StatementsResponse }) {
  const { t } = useI18n();
  if (data.rows.length === 0) {
    return <p className="fund-unavailable">{t('fund.noStatements')}</p>;
  }
  // One currency per statement in practice; show every distinct one rather than assume.
  const currencies = [...new Set(data.rows.map((r) => r.reportedCurrency))].join(', ');
  return (
    <>
      <p className="fund-currency" data-testid="reported-currency">
        {t('fund.reportedIn', { currencies })}
      </p>
      <div className="fund-table-wrap">
        <table className="fund-table">
          <thead>
            <tr>
              <th scope="col">{t('fund.lineItem')}</th>
              {data.rows.map((r) => (
                <th key={`${r.fiscalYear}-${r.fiscalPeriod}`} scope="col" title={t('fund.periodEnds', { date: r.periodEnd })}>
                  {fiscalLabel(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.lineItems.map((li) => (
              <tr key={li.key}>
                <th scope="row">{lineLabel(li.key, li.label)}</th>
                {data.rows.map((r) => {
                  const v = r.lines[li.key] ?? null;
                  return (
                    <td key={`${r.fiscalYear}-${r.fiscalPeriod}`} title={v === null ? undefined : String(v)}>
                      {formatCell(li.key, v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
