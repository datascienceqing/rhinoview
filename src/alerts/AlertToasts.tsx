/**
 * Popups of alerts that fired (docs/ALERTS_PLAN.md, section 4.5): bottom left, newest at the
 * bottom, up to 3, then one "{n} more alerts" line. Each one shrinks into the bell after
 * TOAST_MS (the provider owns the timers). Dismiss marks the event as checked.
 */
import type { AlertEvent } from '@shared/types';
import { INTL_LOCALE, useI18n } from '../i18n';
import { formatPrice } from '../ui/format';
import { useAlerts } from './AlertsProvider';
import { DIRECTION_ARROW, formatValue, messageOf } from './describe';

export const MAX_TOASTS = 3;

export function AlertToasts() {
  const { toasts, soundBlocked, sound } = useAlerts();
  const { t } = useI18n();
  if (toasts.length === 0) return null;
  const shown = toasts.slice(0, MAX_TOASTS);
  const more = toasts.length - shown.length;
  return (
    <div className="alert-toasts" role="region" aria-label={t('alerts.title')}>
      {more > 0 && <div className="alert-toast-more">{t('alerts.toast.more', { count: more })}</div>}
      {[...shown].reverse().map((e) => (
        <Toast key={e.id} event={e} />
      ))}
      {soundBlocked && sound.on && <div className="alert-toast-note">{t('alerts.soundBlocked')}</div>}
    </div>
  );
}

function Toast({ event }: { event: AlertEvent }) {
  const { t, locale } = useI18n();
  const { dismissToast, showOnChart } = useAlerts();
  const value = event.condition.type === 'price' ? formatPrice(event.value) : formatValue(event.value);
  const time = new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeStyle: 'short' }).format(event.firedAt * 1000);
  return (
    <div className={`alert-toast crossed-${event.crossed}`} role="alert" aria-label={t('alerts.toast.label', { symbol: event.symbol })}>
      <div className="alert-toast-head">
        <span className="alert-toast-symbol">{event.symbol}</span>
        <span className={`alert-toast-value ${event.crossed === 'up' ? 'up' : 'down'}`}>
          {event.crossed === 'up' ? DIRECTION_ARROW.up : DIRECTION_ARROW.down} {value}
        </span>
        <time className="alert-toast-time">{time}</time>
      </div>
      <div className="alert-toast-message">{messageOf(event)}</div>
      {event.delayed && <div className="alert-toast-note">{t('alerts.delayed')}</div>}
      <div className="alert-toast-actions">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            showOnChart(event);
            dismissToast(event.id);
          }}
        >
          {t('alerts.toast.show')}
        </button>
        <button type="button" className="link-button" onClick={() => dismissToast(event.id)}>
          {t('common.dismiss')}
        </button>
      </div>
    </div>
  );
}
