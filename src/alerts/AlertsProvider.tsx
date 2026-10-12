/**
 * Alerts state for the whole app (docs/ALERTS_PLAN.md, sections 4.5–4.6, 5.4).
 *
 * It loads the alerts and the event log, listens to `/api/alerts/stream`, and keeps:
 *  - the popups (toasts) of events that fired while the page is open,
 *  - the Alerts window (open or minimized, and its tab),
 *  - the alert dialog (create or edit).
 *
 * The stream is an EventSource, which connects again by itself after a loss. Each time it
 * opens again, the provider loads the alerts and the events again, so nothing is missed.
 * Without EventSource (old browsers, jsdom) it polls the events instead.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Alert, AlertCondition, AlertEvent, AlertStreamMessage, CreateAlertBody, EntityId, UpdateAlertBody } from '@shared/types';
import { ALERT_MIN_CHECK_SECONDS } from '@shared/types';
import { useActiveChart } from '../workspace';
import * as api from './api';
import { isSoundBlocked, playChime, readSoundSettings, storeSoundSettings, unlockOnFirstGesture } from './chime';
import type { SoundSettings } from './chime';
import { messageOf } from './describe';

export type AlertsTab = 'triggered' | 'alerts';

/** What the dialog edits: a new alert (no id) or an existing one. */
export interface AlertDraft {
  id?: EntityId;
  revision?: number;
  symbol: string;
  condition: AlertCondition;
  frequency?: Alert['frequency'];
  expiry?: Alert['expiry'];
  message?: string;
}

export interface AlertsState {
  status: 'loading' | 'ready' | 'error';
  alerts: Alert[];
  /** Newest first. */
  events: AlertEvent[];
  unchecked: number;
  checkIntervalSeconds: number;
  /** Popups now on screen, newest first. */
  toasts: AlertEvent[];
  windowOpen: boolean;
  /** Changes each time the bell opens the window, so the window goes back to its docked place. */
  windowKey: number;
  tab: AlertsTab;
  dialog: AlertDraft | null;
  sound: SoundSettings;
  soundBlocked: boolean;
  /** The checker ran out of upstream calls and checks some alerts late; null when no warning shows. */
  budgetWarning: { budgetPerMinute: number; waitingSymbols: number } | null;

  openWindow(tab?: AlertsTab): void;
  minimizeWindow(): void;
  setTab(tab: AlertsTab): void;
  openDialog(draft: AlertDraft): void;
  closeDialog(): void;
  /** Close a popup and mark its event as checked. */
  dismissToast(id: EntityId): void;
  /** Close a popup without a change: it shrank into the bell. */
  minimizeToast(id: EntityId): void;
  /** Show the symbol (and the timeframe of an indicator alert) on the chart. */
  showOnChart(item: { symbol: string; condition: AlertCondition }): void;
  create(body: CreateAlertBody): Promise<Alert>;
  update(id: EntityId, body: UpdateAlertBody): Promise<Alert>;
  remove(id: EntityId): Promise<void>;
  removeEvent(id: EntityId): Promise<void>;
  markChecked(ids: EntityId[]): Promise<void>;
  markAllChecked(): Promise<void>;
  setSound(settings: SoundSettings): void;
  dismissBudgetWarning(): void;
}

/** How long a popup stays before it shrinks into the bell (D7). */
export const TOAST_MS = 30_000;
/** Poll interval when there is no EventSource. */
export const POLL_MS = 30_000;

const noop = () => undefined;
const rejected = () => Promise.reject(new Error('No AlertsProvider'));

const EMPTY: AlertsState = {
  status: 'ready',
  alerts: [],
  events: [],
  unchecked: 0,
  checkIntervalSeconds: ALERT_MIN_CHECK_SECONDS,
  toasts: [],
  windowOpen: false,
  windowKey: 0,
  tab: 'triggered',
  dialog: null,
  sound: { on: false, volume: 0 },
  soundBlocked: false,
  budgetWarning: null,
  openWindow: noop,
  minimizeWindow: noop,
  setTab: noop,
  openDialog: noop,
  closeDialog: noop,
  dismissToast: noop,
  minimizeToast: noop,
  showOnChart: noop,
  create: rejected,
  update: rejected,
  remove: rejected,
  removeEvent: rejected,
  markChecked: rejected,
  markAllChecked: rejected,
  setSound: noop,
  dismissBudgetWarning: noop,
};

const AlertsContext = createContext<AlertsState>(EMPTY);

/** The alerts state. Without a provider: an empty, inert state (components rendered alone in tests). */
export function useAlerts(): AlertsState {
  return useContext(AlertsContext);
}

export type EventSourceFactory = (url: string) => EventSource | null;

const defaultEventSource: EventSourceFactory = (url) => (typeof EventSource === 'undefined' ? null : new EventSource(url));

export interface AlertsProviderProps {
  children: ReactNode;
  /** Tests inject a fake; null disables the stream (then the provider polls). */
  eventSource?: EventSourceFactory;
  /** Browser notification when the tab is hidden (D8). Tests replace it. */
  notify?: (title: string, body: string) => void;
}

function defaultNotify(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') return;
  try {
    new Notification(title, { body, tag: 'rhinoview-alert' });
  } catch {
    // Some browsers allow notifications only from a service worker.
  }
}

/** Merge new events into a newest-first list, by id. */
function mergeEvents(current: readonly AlertEvent[], incoming: readonly AlertEvent[]): AlertEvent[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.firedAt - a.firedAt);
}

export function AlertsProvider({ children, eventSource = defaultEventSource, notify = defaultNotify }: AlertsProviderProps) {
  const { setSymbol, setTimeframe } = useActiveChart();
  const [status, setStatus] = useState<AlertsState['status']>('loading');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [unchecked, setUnchecked] = useState(0);
  const [checkIntervalSeconds, setInterval_] = useState(ALERT_MIN_CHECK_SECONDS);
  const [toasts, setToasts] = useState<AlertEvent[]>([]);
  const [windowOpen, setWindowOpen] = useState(false);
  const [windowKey, setWindowKey] = useState(0);
  const [tab, setTab] = useState<AlertsTab>('triggered');
  const [dialog, setDialog] = useState<AlertDraft | null>(null);
  const [sound, setSoundState] = useState<SoundSettings>(readSoundSettings);
  const [soundBlocked, setSoundBlocked] = useState(isSoundBlocked);
  const [budgetWarning, setBudgetWarning] = useState<AlertsState['budgetWarning']>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const toastTimers = useRef(new Map<EntityId, ReturnType<typeof setTimeout>>());
  /** Event ids already known, so a message that arrives twice counts once. */
  const seen = useRef(new Set<EntityId>());
  /**
   * One list per event load in flight. A `fired` message that arrives while a load runs goes
   * into each list, so the load's answer (which can be older) does not drop it.
   */
  const inflight = useRef(new Set<AlertEvent[]>());

  const loadAlerts = useCallback(async () => {
    const r = await api.fetchAlerts();
    setAlerts(r.alerts);
    setInterval_(r.checkIntervalSeconds);
  }, []);

  const loadEvents = useCallback(async () => {
    const arrived: AlertEvent[] = [];
    inflight.current.add(arrived);
    try {
      const r = await api.fetchAlertEvents();
      for (const e of r.events) seen.current.add(e.id);
      const known = new Set(r.events.map((e) => e.id));
      const missing = arrived.filter((e) => !known.has(e.id));
      setEvents(mergeEvents(r.events, missing));
      setUnchecked(r.unchecked + missing.filter((e) => !e.checked).length);
    } finally {
      inflight.current.delete(arrived);
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      await Promise.all([loadAlerts(), loadEvents()]);
      setStatus('ready');
    } catch {
      setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [loadAlerts, loadEvents]);

  const minimizeToast = useCallback((id: EntityId) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((list) => list.filter((e) => e.id !== id));
  }, []);

  const onFired = useCallback(
    (event: AlertEvent, alert: Alert) => {
      setAlerts((list) => (list.some((a) => a.id === alert.id) ? list.map((a) => (a.id === alert.id ? alert : a)) : [alert, ...list]));
      if (seen.current.has(event.id)) return;
      seen.current.add(event.id);
      for (const list of inflight.current) list.push(event);
      setEvents((list) => mergeEvents(list, [event]));
      setUnchecked((n) => n + 1);
      setToasts((list) => [event, ...list.filter((e) => e.id !== event.id)]);
      if (!toastTimers.current.has(event.id)) {
        toastTimers.current.set(
          event.id,
          setTimeout(() => minimizeToast(event.id), TOAST_MS),
        );
      }
      playChime(soundRef.current);
      notifyRef.current(event.symbol, messageOf(event));
    },
    [minimizeToast],
  );

  // First load, and the stream (or the poll).
  useEffect(() => {
    void loadAll();
    const source = eventSource(api.ALERT_STREAM_URL);
    if (!source) {
      const id = setInterval(() => void loadAll(), POLL_MS);
      return () => clearInterval(id);
    }
    let opened = false;
    const onOpen = () => {
      // Opened again after a loss: load what changed in the meantime.
      if (opened) void loadAll();
      opened = true;
    };
    const parse = (e: Event): AlertStreamMessage | null => {
      try {
        return JSON.parse((e as MessageEvent<string>).data) as AlertStreamMessage;
      } catch {
        return null;
      }
    };
    const onFiredMessage = (e: Event) => {
      const m = parse(e);
      if (m?.type === 'fired') onFired(m.event, m.alert);
    };
    const onChecked = (e: Event) => {
      const m = parse(e);
      if (m?.type !== 'checked') return;
      setUnchecked(m.unchecked);
      // The message names the change: apply it here, with no load of the whole log.
      if (m.deletedId !== undefined) {
        const id = m.deletedId;
        setEvents((list) => list.filter((x) => x.id !== id));
      } else if (m.checkedIds === 'all') {
        setEvents((list) => list.map((x) => (x.checked ? x : { ...x, checked: true })));
      } else if (m.checkedIds !== undefined) {
        const ids = new Set(m.checkedIds);
        setEvents((list) => list.map((x) => (ids.has(x.id) && !x.checked ? { ...x, checked: true } : x)));
      } else {
        void loadEvents().catch(noop);
      }
    };
    const onAlerts = () => void loadAlerts().catch(noop);
    const onBudget = (e: Event) => {
      const m = parse(e);
      if (m?.type === 'budget') setBudgetWarning({ budgetPerMinute: m.budgetPerMinute, waitingSymbols: m.waitingSymbols });
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('fired', onFiredMessage);
    source.addEventListener('checked', onChecked);
    source.addEventListener('alerts', onAlerts);
    source.addEventListener('budget', onBudget);
    return () => {
      source.removeEventListener('budget', onBudget);
      source.removeEventListener('open', onOpen);
      source.removeEventListener('fired', onFiredMessage);
      source.removeEventListener('checked', onChecked);
      source.removeEventListener('alerts', onAlerts);
      source.close();
    };
  }, [eventSource, loadAll, loadAlerts, loadEvents, onFired]);

  // Sound needs one user gesture first.
  useEffect(() => unlockOnFirstGesture(document, () => setSoundBlocked(false)), []);

  // Timers of popups end with the provider.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const markChecked = useCallback(async (ids: EntityId[]) => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setEvents((list) => list.map((e) => (set.has(e.id) ? { ...e, checked: true } : e)));
    const r = await api.setEventsChecked({ ids });
    setUnchecked(r.unchecked);
  }, []);

  const value = useMemo<AlertsState>(
    () => ({
      status,
      alerts,
      events,
      unchecked,
      checkIntervalSeconds,
      toasts,
      windowOpen,
      windowKey,
      tab,
      dialog,
      sound,
      soundBlocked,
      budgetWarning,
      openWindow(next = 'triggered') {
        setTab(next);
        setWindowKey((k) => k + 1);
        setWindowOpen(true);
      },
      minimizeWindow: () => setWindowOpen(false),
      setTab,
      openDialog: setDialog,
      closeDialog: () => setDialog(null),
      dismissToast(id) {
        minimizeToast(id);
        void markChecked([id]).catch(noop);
      },
      minimizeToast,
      showOnChart(item) {
        setSymbol(item.symbol);
        if (item.condition.type === 'indicator') setTimeframe(item.condition.timeframe);
      },
      async create(body) {
        const a = await api.createAlert(body);
        setAlerts((list) => [a, ...list.filter((x) => x.id !== a.id)]);
        return a;
      },
      async update(id, body) {
        const a = await api.updateAlert(id, body);
        setAlerts((list) => list.map((x) => (x.id === a.id ? a : x)));
        return a;
      },
      async remove(id) {
        await api.deleteAlert(id);
        setAlerts((list) => list.filter((x) => x.id !== id));
      },
      async removeEvent(id) {
        const r = await api.deleteAlertEvent(id);
        minimizeToast(id);
        setEvents((list) => list.filter((e) => e.id !== id));
        setUnchecked(r.unchecked);
      },
      markChecked,
      async markAllChecked() {
        setEvents((list) => list.map((e) => (e.checked ? e : { ...e, checked: true })));
        const r = await api.setEventsChecked({ all: true });
        setUnchecked(r.unchecked);
      },
      setSound(next) {
        storeSoundSettings(next);
        setSoundState(next);
      },
      dismissBudgetWarning: () => setBudgetWarning(null),
    }),
    [status, alerts, events, unchecked, checkIntervalSeconds, toasts, windowOpen, windowKey, tab, dialog, sound, soundBlocked, budgetWarning, minimizeToast, markChecked, setSymbol, setTimeframe],
  );

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}
