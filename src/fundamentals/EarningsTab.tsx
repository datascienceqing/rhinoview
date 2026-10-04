import type { EarningsEvent } from '@shared/types';
import { outcomeOf, surprisePercent, useEarnings } from './earnings';
import type { EarningsOutcome } from './earnings';
import { AsyncBlock } from './AsyncBlock';
import { DASH, formatLarge, formatNumber, formatSignedPercent } from './format';

const OUTCOME_LABEL: Record<EarningsOutcome, string> = {
  beat: 'Beat',
  miss: 'Miss',
  inline: 'In line',
  upcoming: 'Upcoming',
  unknown: DASH,
};

export function EarningsTab({ symbol }: { symbol: string }) {
  const state = useEarnings(symbol);
  return (
    <AsyncBlock state={state} loading="Loading earnings…">
      {(d) =>
        d.events.length === 0 ? (
          <p className="fund-unavailable">No earnings reports.</p>
        ) : (
          <div className="fund-table-wrap">
            <table className="fund-table fund-earnings" data-testid="earnings-table">
              <thead>
                <tr>
                  <th scope="col">Report date</th>
                  <th scope="col">Result</th>
                  <th scope="col">EPS actual</th>
                  <th scope="col">EPS estimate</th>
                  <th scope="col">EPS surprise</th>
                  <th scope="col">Revenue actual</th>
                  <th scope="col">Revenue estimate</th>
                  <th scope="col">Revenue surprise</th>
                </tr>
              </thead>
              <tbody>
                {d.events.map((e) => (
                  <EarningsRow key={e.date} event={e} />
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </AsyncBlock>
  );
}

function EarningsRow({ event: e }: { event: EarningsEvent }) {
  const outcome = outcomeOf(e);
  const upcoming = outcome === 'upcoming';
  return (
    <tr data-testid={`earnings-${e.date}`} data-outcome={outcome}>
      <th scope="row">{e.date}</th>
      <td className={`fund-outcome fund-${outcome}`}>{OUTCOME_LABEL[outcome]}</td>
      <td>{upcoming ? DASH : formatNumber(e.epsActual)}</td>
      <td>{formatNumber(e.epsEstimate)}</td>
      <td>{upcoming ? DASH : formatSignedPercent(surprisePercent(e.epsActual, e.epsEstimate))}</td>
      <td>{upcoming ? DASH : formatLarge(e.revenueActual)}</td>
      <td>{formatLarge(e.revenueEstimate)}</td>
      <td>{upcoming ? DASH : formatSignedPercent(surprisePercent(e.revenueActual, e.revenueEstimate))}</td>
    </tr>
  );
}
