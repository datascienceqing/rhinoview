import { TIMEFRAMES } from '@shared/types';
import type { Timeframe } from '@shared/types';

export interface TimeframeSelectorProps {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export function TimeframeSelector({ value, onChange }: TimeframeSelectorProps) {
  return (
    <div className="segmented" role="group" aria-label="Timeframe">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          type="button"
          aria-pressed={tf === value}
          className={tf === value ? 'seg active' : 'seg'}
          onClick={() => onChange(tf)}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
