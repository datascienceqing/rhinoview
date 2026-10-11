/** The bell at the right end of the toolbar (docs/ALERTS_PLAN.md, section 4.6). */
import { useI18n } from '../i18n';
import { useAlerts } from './AlertsProvider';

export function AlertBell() {
  const { unchecked, openWindow, windowOpen } = useAlerts();
  const { t } = useI18n();
  const label = unchecked > 0 ? t('alerts.bellCount', { count: unchecked }) : t('alerts.bell');
  return (
    <button
      type="button"
      className={`toolbar-toggle alert-bell${windowOpen ? ' active' : ''}`}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={windowOpen}
      onClick={() => openWindow('triggered')}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"
        />
      </svg>
      {unchecked > 0 && <span className="alert-bell-count">{unchecked > 99 ? '99+' : unchecked}</span>}
    </button>
  );
}
