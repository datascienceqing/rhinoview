import type { ChartType } from '@shared/types';

const OPTIONS: readonly { value: ChartType; label: string }[] = [
  { value: 'candlestick', label: 'Candles' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
];

export interface ChartTypeSelectorProps {
  value: ChartType;
  onChange: (type: ChartType) => void;
}

export function ChartTypeSelector({ value, onChange }: ChartTypeSelectorProps) {
  return (
    <div className="segmented" role="group" aria-label="Chart type">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={o.value === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
