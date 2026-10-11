import type { Bar } from '@shared/types';
import { directionClass, formatChange, formatPercent, formatPrice, formatVolume } from './format';
import { useI18n } from '../i18n';
import { buildLegend } from './legend';

export interface CrosshairLegendProps {
  bars: readonly Bar[];
  /** Time under the crosshair, or null when it is off the chart. */
  hoverTime: number | null;
}

export function CrosshairLegend({ bars, hoverTime }: CrosshairLegendProps) {
  const { t } = useI18n();
  const model = buildLegend(bars, hoverTime);
  if (!model) return null;
  const { bar, change, changePercent } = model;
  const dir = directionClass(change);
  return (
    <div className={`legend ${dir}`} data-testid="crosshair-legend" aria-label={t('legend.hovered')}>
      <span className="legend-item">
        <span className="legend-label">{t('legend.open')}</span>
        <span data-testid="legend-open">{formatPrice(bar.open)}</span>
      </span>
      <span className="legend-item">
        <span className="legend-label">{t('legend.high')}</span>
        <span data-testid="legend-high">{formatPrice(bar.high)}</span>
      </span>
      <span className="legend-item">
        <span className="legend-label">{t('legend.low')}</span>
        <span data-testid="legend-low">{formatPrice(bar.low)}</span>
      </span>
      <span className="legend-item">
        <span className="legend-label">{t('legend.close')}</span>
        <span data-testid="legend-close">{formatPrice(bar.close)}</span>
      </span>
      <span className="legend-item neutral">
        <span className="legend-label">{t('legend.volume')}</span>
        <span data-testid="legend-volume">{formatVolume(bar.volume)}</span>
      </span>
      <span className="legend-item" data-testid="legend-change">
        {formatChange(change)} ({formatPercent(changePercent)})
      </span>
    </div>
  );
}
