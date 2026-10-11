import { useEffect, useRef, useState } from 'react';
import type { EarningsEvent, EarningsResponse } from '@shared/types';
import { DEFAULT_EARNINGS_LIMIT, MAX_EARNINGS_LIMIT } from '@shared/types';
import { fetchEarnings } from './api';
import { outcomeOf, surprisePercent, useEarnings } from './earnings';
import type { EarningsOutcome } from './earnings';
import { AsyncBlock } from './AsyncBlock';
import { DASH, formatLarge, formatNumber, formatSignedPercent } from './format';
import { t, useI18n } from '../i18n';

function outcomeLabel(outcome: EarningsOutcome): string {
  return outcome === 'unknown' ? DASH : t(`fund.outcome.${outcome}`);
}

/** A longer list than the shared initial one, for one symbol. */
interface Extended {
  symbol: string;
  /** The limit that produced `data`. */
  limit: number;
  data: EarningsResponse;
}

export function EarningsTab({ symbol }: { symbol: string }) {
  const { t: tr } = useI18n();
  const state = useEarnings(symbol);
  return (
    <AsyncBlock state={state} loading={tr('fund.loadingEarnings')}>
      {(d) => <EarningsBody key={symbol} symbol={symbol} initial={d} />}
    </AsyncBlock>
  );
}

function EarningsBody({ symbol, initial }: { symbol: string; initial: EarningsResponse }) {
  const { t: tr } = useI18n();
  const [extended, setExtended] = useState<Extended | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  useEffect(() => () => void (request.current += 1), []); // drop answers after unmount

  const current = extended && extended.symbol === symbol ? extended : null;
  const limit = current?.limit ?? DEFAULT_EARNINGS_LIMIT;
  const events = (current?.data ?? initial).events;
  // Exactly `limit` events means there may be more; fewer means that is all of them.
  const canShowMore = events.length === limit && limit < MAX_EARNINGS_LIMIT;

  function showMore() {
    const next = Math.min(limit + DEFAULT_EARNINGS_LIMIT, MAX_EARNINGS_LIMIT);
    const mine = ++request.current;
    setLoading(true);
    setFailed(false);
    fetchEarnings(symbol, next).then(
      (data) => {
        if (request.current !== mine) return;
        setExtended({ symbol, limit: next, data });
        setLoading(false);
      },
      () => {
        if (request.current !== mine) return;
        setFailed(true);
        setLoading(false);
      },
    );
  }

  if (events.length === 0) return <p className="fund-unavailable">{tr('fund.noEarnings')}</p>;
  return (
    <>
      <div className="fund-table-wrap">
        <table className="fund-table fund-earnings" data-testid="earnings-table">
          <thead>
            <tr>
              <th scope="col">{tr('fund.col.date')}</th>
              <th scope="col">{tr('fund.col.result')}</th>
              <th scope="col">{tr('fund.col.epsActual')}</th>
              <th scope="col">{tr('fund.col.epsEstimate')}</th>
              <th scope="col">{tr('fund.col.epsSurprise')}</th>
              <th scope="col">{tr('fund.col.revActual')}</th>
              <th scope="col">{tr('fund.col.revEstimate')}</th>
              <th scope="col">{tr('fund.col.revSurprise')}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <EarningsRow key={e.date} event={e} />
            ))}
          </tbody>
        </table>
      </div>
      {failed && (
        <p className="fund-unavailable" role="alert">
          {tr('fund.moreFailed')}{' '}
          <button type="button" className="fund-retry" onClick={showMore}>
            {tr('common.retry')}
          </button>
        </p>
      )}
      {canShowMore && !failed && (
        <button type="button" className="fund-more" disabled={loading} onClick={showMore}>
          {loading ? tr('common.loading') : tr('fund.showMore')}
        </button>
      )}
    </>
  );
}

function EarningsRow({ event: e }: { event: EarningsEvent }) {
  const outcome = outcomeOf(e);
  const upcoming = outcome === 'upcoming';
  return (
    <tr data-testid={`earnings-${e.date}`} data-outcome={outcome}>
      <th scope="row">{e.date}</th>
      <td className={`fund-outcome fund-${outcome}`}>{outcomeLabel(outcome)}</td>
      <td>{upcoming ? DASH : formatNumber(e.epsActual)}</td>
      <td>{formatNumber(e.epsEstimate)}</td>
      <td>{upcoming ? DASH : formatSignedPercent(surprisePercent(e.epsActual, e.epsEstimate))}</td>
      <td>{upcoming ? DASH : formatLarge(e.revenueActual)}</td>
      <td>{formatLarge(e.revenueEstimate)}</td>
      <td>{upcoming ? DASH : formatSignedPercent(surprisePercent(e.revenueActual, e.revenueEstimate))}</td>
    </tr>
  );
}
