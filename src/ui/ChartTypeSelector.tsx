import type { ChartType } from '@shared/types';
import { useI18n } from '../i18n';

const OPTIONS: readonly ChartType[] = ['candlestick', 'line', 'area'];

export interface ChartTypeSelectorProps {
  value: ChartType;
  onChange: (type: ChartType) => void;
}

export function ChartTypeSelector({ value, onChange }: ChartTypeSelectorProps) {
  const { t } = useI18n();
  return (
    <div className="segmented" role="group" aria-label={t('chartType.group')}>
      {OPTIONS.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          className={o === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o)}
        >
          {t(`chartType.${o}`)}
        </button>
      ))}
    </div>
  );
}
