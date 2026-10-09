import { useState } from 'react';
import type { StatementKind, StatementPeriod, StatementsResponse } from '@shared/types';
import { useAsync } from '../data';
import { fetchStatements } from './api';
import { AsyncBlock } from './AsyncBlock';
import { DASH, fiscalLabel, formatLarge, formatNumber } from './format';

const KINDS: { value: StatementKind; label: string }[] = [
  { value: 'income', label: 'Income' },
  { value: 'balance', label: 'Balance sheet' },
  { value: 'cashflow', label: 'Cash flow' },
];

export function PeriodToggle({ value, onChange }: { value: StatementPeriod; onChange: (p: StatementPeriod) => void }) {
  return (
    <div className="fund-seg" role="group" aria-label="Period">
      {(['annual', 'quarter'] as const).map((p) => (
        <button key={p} type="button" aria-pressed={value === p} onClick={() => onChange(p)}>
          {p === 'annual' ? 'Annual' : 'Quarterly'}
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
  if (isShareCount(key)) return `${formatLarge(v)} shares`;
  return formatLarge(v);
}

export function StatementsTab({ symbol }: { symbol: string }) {
  const [kind, setKind] = useState<StatementKind>('income');
  const [period, setPeriod] = useState<StatementPeriod>('annual');
  const state = useAsync(`statements:${symbol}:${kind}:${period}`, () => fetchStatements(symbol, kind, period));
  return (
    <div className="fund-statements">
      <div className="fund-controls">
        <div className="fund-seg" role="group" aria-label="Statement">
          {KINDS.map((k) => (
            <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)}>
              {k.label}
            </button>
          ))}
        </div>
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>
      <AsyncBlock state={state} loading="Loading statements…">
        {(s) => <StatementTable data={s} />}
      </AsyncBlock>
    </div>
  );
}

function StatementTable({ data }: { data: StatementsResponse }) {
  if (data.rows.length === 0) {
    return <p className="fund-unavailable">No statements reported.</p>;
  }
  // One currency per statement in practice; show every distinct one rather than assume.
  const currencies = [...new Set(data.rows.map((r) => r.reportedCurrency))].join(', ');
  return (
    <>
      <p className="fund-currency" data-testid="reported-currency">
        Reported in {currencies}. Amounts use M (million), B (billion) and T (trillion).
      </p>
      <div className="fund-table-wrap">
        <table className="fund-table">
          <thead>
            <tr>
              <th scope="col">Line item</th>
              {data.rows.map((r) => (
                <th key={`${r.fiscalYear}-${r.fiscalPeriod}`} scope="col" title={`Period ends ${r.periodEnd}`}>
                  {fiscalLabel(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.lineItems.map((li) => (
              <tr key={li.key}>
                <th scope="row">{li.label}</th>
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
