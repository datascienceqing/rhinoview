import { TIMEFRAMES } from '@shared/types';
import type { Capabilities, Timeframe } from '@shared/types';

/**
 * The timeframe the UI should actually show and fetch, given what the provider serves.
 *
 * A saved timeframe the provider cannot serve (the FMP plan has no 1m) must not
 * produce a chart that is broken on every load. We show the NEAREST supported one and
 * prefer the next COARSER on a tie: coarser bars always exist where finer ones do. This
 * is a view-only fallback; the saved layout keeps its timeframe until the user picks one.
 * While capabilities are unknown (`null`), or if they list nothing usable, nothing changes.
 */
export function effectiveTimeframe(saved: Timeframe, capabilities: Pick<Capabilities, 'timeframes'> | null): Timeframe {
  if (!capabilities) return saved;
  const supported = new Set<Timeframe>(capabilities.timeframes);
  if (supported.has(saved)) return saved;
  const at = TIMEFRAMES.indexOf(saved);
  for (let d = 1; d < TIMEFRAMES.length; d += 1) {
    const coarser = TIMEFRAMES[at + d];
    if (coarser && supported.has(coarser)) return coarser;
    const finer = TIMEFRAMES[at - d];
    if (finer && supported.has(finer)) return finer;
  }
  return saved;
}
