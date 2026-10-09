import { TIMEFRAMES } from '@shared/types';
import type { Timeframe } from '@shared/types';
import { useCapabilities } from '../data';
import { effectiveTimeframe } from '../workspace';
import '../layouts/layouts.css';

export interface TimeframeSelectorProps {
  /** The SAVED timeframe. It may be one the provider cannot serve. */
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export function TimeframeSelector({ value, onChange }: TimeframeSelectorProps) {
  // Null while unknown (or if the request failed): every timeframe stays enabled.
  const capabilities = useCapabilities();
  const supported = capabilities ? new Set<Timeframe>(capabilities.timeframes) : null;
  const shown = effectiveTimeframe(value, capabilities);

  return (
    <>
      {shown !== value && (
        <span className="chip" role="status" data-testid="timeframe-fallback-notice">
          {value} is not available from this data provider. Showing {shown}.
        </span>
      )}
      <div className="segmented" role="group" aria-label="Timeframe">
        {TIMEFRAMES.map((tf) => {
          const enabled = supported === null || supported.has(tf);
          return (
            <button
              key={tf}
              type="button"
              aria-pressed={tf === shown}
              className={tf === shown ? 'seg active' : 'seg'}
              disabled={!enabled}
              title={enabled ? undefined : `${tf} is not available from this data provider`}
              onClick={() => onChange(tf)}
            >
              {tf}
            </button>
          );
        })}
      </div>
    </>
  );
}
