import { TIMEFRAMES } from '@shared/types';
import type { Timeframe } from '@shared/types';
import { useCapabilities } from '../data';
import { useI18n } from '../i18n';
import { effectiveTimeframe } from '../workspace';
import '../layouts/layouts.css';

export interface TimeframeSelectorProps {
  /** The SAVED timeframe. It may be one the provider cannot serve. */
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export function TimeframeSelector({ value, onChange }: TimeframeSelectorProps) {
  // Null while unknown (or if the request failed): every timeframe stays enabled.
  const { t } = useI18n();
  const capabilities = useCapabilities();
  const supported = capabilities ? new Set<Timeframe>(capabilities.timeframes) : null;
  const shown = effectiveTimeframe(value, capabilities);

  return (
    <>
      {shown !== value && (
        <span className="chip" role="status" data-testid="timeframe-fallback-notice">
          {t('timeframe.fallback', { saved: t(`timeframe.${value}`), shown: t(`timeframe.${shown}`) })}
        </span>
      )}
      <div className="segmented" role="group" aria-label={t('timeframe.group')}>
        {TIMEFRAMES.map((tf) => {
          const enabled = supported === null || supported.has(tf);
          return (
            <button
              key={tf}
              type="button"
              aria-pressed={tf === shown}
              className={tf === shown ? 'seg active' : 'seg'}
              disabled={!enabled}
              title={enabled ? undefined : t('timeframe.unavailable', { tf: t(`timeframe.${tf}`) })}
              onClick={() => onChange(tf)}
            >
              {t(`timeframe.${tf}`)}
            </button>
          );
        })}
      </div>
    </>
  );
}
