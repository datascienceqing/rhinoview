/**
 * The Alerts window (docs/ALERTS_PLAN.md, section 4.6): docked on the right over the
 * watchlist by default, floating after a drag of the title bar, minimized into the bell.
 * Two tabs, one search box, and a different look for each type and status.
 */
import { useEffect, useRef, useState } from 'react';
import type { Alert, AlertCondition, AlertEvent } from '@shared/types';
import { INTL_LOCALE, useI18n } from '../i18n';
import { useAlerts } from './AlertsProvider';
import type { AlertsTab } from './AlertsProvider';
import { DIRECTION_ARROW, formatLevel, formatValue, intervalText, matchesSearch, messageOf, sortAlerts, sortEvents, summaryOf } from './describe';
import { useFloatingWindow } from './useFloatingWindow';

const KEY_STEP = 20;

export function AlertsWindow() {
  const { windowOpen, windowKey } = useAlerts();
  if (!windowOpen) return null;
  // A new key each time the bell opens it: the window starts docked again.
  return <AlertsWindowPanel key={windowKey} />;
}

function KindIcon({ condition }: { condition: AlertCondition }) {
  return condition.type === 'price' ? (
    <svg className="alert-kind" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8h14" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" />
    </svg>
  ) : (
    <svg className="alert-kind" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 10c2-6 4-6 6 0s4 6 6 0 2-4 2-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function AlertsWindowPanel() {
  const { t } = useI18n();
  const state = useAlerts();
  const { tab, setTab, minimizeWindow, events, alerts, unchecked, checkIntervalSeconds } = state;
  const ref = useRef<HTMLElement>(null);
  const win = useFloatingWindow(ref);
  const [query, setQuery] = useState('');

  useEffect(() => ref.current?.focus(), []);

  const shownEvents = sortEvents(events.filter((e) => matchesSearch(e, query)));
  const shownAlerts = sortAlerts(alerts.filter((a) => matchesSearch(a, query)));

  const tabs: { id: AlertsTab; label: string; count: number }[] = [
    { id: 'triggered', label: t('alerts.tab.triggered'), count: unchecked },
    { id: 'alerts', label: t('alerts.tab.alerts'), count: alerts.length },
  ];

  return (
    <section
      ref={ref}
      className={`alerts-window ${win.docked ? 'docked' : 'floating'}`}
      style={win.pos ? { left: win.pos.x, top: win.pos.y } : undefined}
      role="dialog"
      aria-label={t('alerts.title')}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          minimizeWindow();
        }
      }}
    >
      <header
        className="alerts-window-bar"
        {...win.handleProps}
        onKeyDown={(e) => {
          // Arrow keys on the focused title bar move the window, like a drag.
          const moves: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
          const m = moves[e.key];
          if (m && e.target === e.currentTarget) {
            e.preventDefault();
            win.moveBy(m[0], m[1]);
          }
        }}
        tabIndex={0}
      >
        <span className="alerts-window-title">{t('alerts.title')}</span>
        <span className="alerts-window-interval">{intervalText(checkIntervalSeconds)}</span>
        {!win.docked && (
          <button type="button" className="icon-button" onClick={win.dock} title={t('alerts.dock')} aria-label={t('alerts.dock')}>
            ⇥
          </button>
        )}
        <button type="button" className="icon-button" onClick={minimizeWindow} title={t('alerts.minimize')} aria-label={t('alerts.minimize')}>
          —
        </button>
      </header>

      <div className="alerts-tabs" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            className={`alerts-tab${tab === x.id ? ' active' : ''}`}
            onClick={() => setTab(x.id)}
          >
            {x.label}
            {x.count > 0 && <span className="alerts-tab-count">{x.count}</span>}
          </button>
        ))}
      </div>

      <div className="alerts-tools">
        <input type="search" className="alerts-search" placeholder={t('alerts.search')} aria-label={t('alerts.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {tab === 'triggered' && (
          <button type="button" className="button-secondary" disabled={unchecked === 0} onClick={() => void state.markAllChecked().catch(() => undefined)}>
            {t('alerts.markAll')}
          </button>
        )}
      </div>

      <div className="alerts-list" role="tabpanel">
        {tab === 'triggered' ? <EventRows events={shownEvents} empty={events.length === 0} /> : <AlertRows alerts={shownAlerts} empty={alerts.length === 0} />}
      </div>

      <SoundSettingsRow />
    </section>
  );
}

function EventRows({ events, empty }: { events: AlertEvent[]; empty: boolean }) {
  const { t, locale } = useI18n();
  const { showOnChart, markChecked, removeEvent } = useAlerts();
  if (events.length === 0) return <p className="alerts-empty">{empty ? t('alerts.empty.triggered') : t('alerts.noMatch')}</p>;
  const time = new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'short', timeStyle: 'short' });
  return (
    <ul className="alerts-rows">
      {events.map((e) => (
        <li key={e.id} className={`alert-row event ${e.checked ? 'checked' : 'unchecked'}`}>
          <button
            type="button"
            className="alert-row-main"
            onClick={() => {
              showOnChart(e);
              if (!e.checked) void markChecked([e.id]).catch(() => undefined);
            }}
          >
            {!e.checked && <span className="alert-dot" aria-label={t('alerts.new')} />}
            <KindIcon condition={e.condition} />
            <span className="alert-row-symbol">{e.symbol}</span>
            <span className="alert-row-text">{messageOf(e)}</span>
            <span className={`alert-row-value ${e.crossed === 'up' ? 'up' : 'down'}`}>
              {e.crossed === 'up' ? DIRECTION_ARROW.up : DIRECTION_ARROW.down} {e.condition.type === 'price' ? formatLevel(e.value) : formatValue(e.value)}
            </span>
            <time
              className="alert-row-time"
              {...(e.barTime !== undefined ? { title: t('alerts.barTime', { date: time.format(e.barTime * 1000) }) } : {})}
            >
              {time.format(e.firedAt * 1000)}
            </time>
          </button>
          <button type="button" className="icon-button" aria-label={`${t('alerts.delete')} ${e.symbol}`} title={t('alerts.delete')} onClick={() => void removeEvent(e.id).catch(() => undefined)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function AlertRows({ alerts, empty }: { alerts: Alert[]; empty: boolean }) {
  const { t, locale } = useI18n();
  const { showOnChart, update, remove, openDialog } = useAlerts();
  if (alerts.length === 0) return <p className="alerts-empty">{empty ? t('alerts.empty.alerts') : t('alerts.noMatch')}</p>;
  const date = new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'medium' });
  const statusIcon: Record<Alert['status'], string> = { active: '', paused: '⏸', triggered: '✓', expired: '' };
  return (
    <ul className="alerts-rows">
      {alerts.map((a) => (
        <li key={a.id} className={`alert-row alert status-${a.status}`}>
          <button type="button" className="alert-row-main" onClick={() => showOnChart(a)}>
            <KindIcon condition={a.condition} />
            <span className="alert-row-symbol">{a.symbol}</span>
            <span className="alert-row-text" title={messageOf(a)}>
              {summaryOf(a.condition)}
            </span>
            <span className="alert-row-status" title={t(`alerts.status.${a.status}`)}>
              {statusIcon[a.status]} {a.frequency === 'every' ? t('alerts.frequency.every') : t('alerts.frequency.once')}
            </span>
            <span className="alert-row-time">{t('alerts.expiresOn', { date: date.format(a.expiresAt * 1000) })}</span>
          </button>
          <span className="alert-row-actions">
            <button
              type="button"
              className="icon-button"
              title={t('alerts.edit')}
              aria-label={`${t('alerts.edit')} ${a.symbol}`}
              onClick={() => openDialog({ id: a.id, revision: a.revision, symbol: a.symbol, condition: a.condition, frequency: a.frequency, expiry: a.expiry, message: a.message })}
            >
              ✎
            </button>
            <button
              type="button"
              className="icon-button"
              title={a.status === 'active' ? t('alerts.pause') : t('alerts.enable')}
              aria-label={`${a.status === 'active' ? t('alerts.pause') : t('alerts.enable')} ${a.symbol}`}
              onClick={() => void update(a.id, { revision: a.revision, status: a.status === 'active' ? 'paused' : 'active' }).catch(() => undefined)}
            >
              {a.status === 'active' ? '⏸' : '▶'}
            </button>
            <button type="button" className="icon-button" title={t('alerts.delete')} aria-label={`${t('alerts.delete')} ${a.symbol}`} onClick={() => void remove(a.id).catch(() => undefined)}>
              ×
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function readPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function SoundSettingsRow() {
  const { t } = useI18n();
  const { sound, setSound } = useAlerts();
  const [permission, setPermission] = useState(readPermission);
  // The user changes the permission in the browser settings, then comes back to the tab.
  useEffect(() => {
    const reread = () => setPermission(readPermission());
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, []);
  return (
    <footer className="alerts-settings">
      <label>
        <input type="checkbox" checked={sound.on} onChange={(e) => setSound({ ...sound, on: e.target.checked })} /> {t('alerts.sound')}
      </label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.1"
        value={sound.volume}
        disabled={!sound.on}
        aria-label={t('alerts.sound')}
        onChange={(e) => setSound({ ...sound, volume: Number(e.target.value) })}
      />
      {permission === 'default' && (
        <button
          type="button"
          className="link-button"
          onClick={() => void Notification.requestPermission().then(setPermission, () => undefined)}
        >
          {t('alerts.notifications')}: {t('alerts.notificationsAllow')}
        </button>
      )}
      {permission === 'denied' && <span className="alerts-settings-note">{t('alerts.notificationsBlocked')}</span>}
    </footer>
  );
}
