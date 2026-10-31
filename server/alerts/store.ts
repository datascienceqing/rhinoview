/**
 * File-backed alerts store (docs/ALERTS_PLAN.md, section 5.2; docs/CONTRACT.md, "Alerts").
 *
 * Its own file (`ALERTS_FILE`), so checker writes never raise the workspace revision.
 * Same rules as the workspace store: state lives in memory after the first load; each
 * write goes through one promise chain; a mutation changes a copy, writes it atomically
 * (temp file, fsync, rename), and only then replaces the state in memory.
 *
 * User edits raise `revision`. The checker (`applyChecks`) writes `state`, the statuses
 * `triggered` and `expired`, and events, and never raises `revision`.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  Alert,
  AlertEvent,
  AlertEventsResponse,
  AlertOrigin,
  AlertStreamMessage,
  CreateAlertBody,
  EntityId,
  SetCheckedBody,
  UnixSeconds,
  UpdateAlertBody,
} from '@shared/types';
import { DEFAULT_ALERT_EXPIRY, MAX_ALERT_EVENTS } from '@shared/types';
import { ALERT_SYMBOL_RE, checkAlertCondition, checkAlertMessage } from '../../src/alerts/condition';
import { computeExpiresAt } from '../../src/alerts/expiry';
import { ApiFailure } from '../provider/errors';
import { nodeWorkspaceFs } from '../workspace/store';
import type { WorkspaceFs } from '../workspace/store';
import type { AlertCheckResult } from './evaluate';
import { ALERTS_FILE_VERSION, alertEventSchema, alertSchema, alertsFileSchema } from './schemas';

/** One check result for the store, with the revision the check started from. */
export interface AppliedCheck {
  alertId: EntityId;
  /** The alert's revision when the check read it. A user edit since then wins: the result is dropped. */
  revision: number;
  result: AlertCheckResult;
  /** The quote or bars behind the check were delayed. */
  delayed: boolean;
}

export interface AlertsStore {
  /** Newest first. */
  list(): Alert[];
  /** `origin` comes from the server only (`POST /api/ai/alerts`), never from a request body. */
  create(body: CreateAlertBody, origin?: AlertOrigin): Promise<Alert>;
  update(id: EntityId, body: UpdateAlertBody): Promise<Alert>;
  remove(id: EntityId): Promise<{ id: EntityId }>;
  /** Newest first. `since` is exclusive. */
  events(since?: UnixSeconds): AlertEventsResponse;
  setChecked(body: SetCheckedBody): Promise<{ unchecked: number }>;
  deleteEvent(id: EntityId): Promise<{ unchecked: number }>;
  /** The checker's write. Returns the new events. */
  applyChecks(checks: readonly AppliedCheck[]): Promise<AlertEvent[]>;
  /**
   * Save a state-only change that is STATE_FLUSH_SECONDS old (or any, with `force`). The checker
   * calls it on each tick, so a change is saved also when no later check comes (a 1D alert).
   */
  flush(force?: boolean): Promise<void>;
  /** Stream messages. Returns the function that unsubscribes. */
  subscribe(listener: (message: AlertStreamMessage) => void): () => void;
  /** Send a message that changes no state (the checker's budget warning) to the listeners. */
  publish(message: AlertStreamMessage): void;
}

export interface AlertsStoreOptions {
  fs?: WorkspaceFs;
  /** Unix seconds. */
  now?: () => number;
  newId?: () => string;
  warn?: (message: string) => void;
}

interface AlertsState {
  alerts: Alert[];
  /** Newest first. */
  events: AlertEvent[];
}

/**
 * State-only changes (no event, no status change) are saved at most this late. A restart can
 * lose them. That is safe: each crossing that fires is saved at once, so a lost change is a
 * side change that did not fire, and the next check only finds that same change again.
 */
export const STATE_FLUSH_SECONDS = 60;

const bad = (message: string): never => {
  throw new ApiFailure('BAD_REQUEST', message);
};

function canonicalSymbol(raw: string): string {
  if (!ALERT_SYMBOL_RE.test(raw)) bad('A symbol must be 1-16 characters: letters, digits and . ^ = -');
  return raw.toUpperCase();
}

function checkFields(b: Pick<UpdateAlertBody, 'condition' | 'message'>): void {
  const conditionError = b.condition ? checkAlertCondition(b.condition) : null;
  if (conditionError !== null) bad(`Invalid condition: ${conditionError}`);
  const messageError = b.message !== undefined ? checkAlertMessage(b.message) : null;
  if (messageError !== null) bad(messageError);
}

const emptyState = (): Alert['state'] => ({
  lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null,
});

/** The side and the bar position: the next check after a reset only records the side. */
const resetSide = (s: Alert['state']): Alert['state'] => ({ ...s, lastSide: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null });

function sameIgnoringCheckTime(a: Alert['state'], b: Alert['state']): boolean {
  return JSON.stringify({ ...a, lastCheckedAt: 0 }) === JSON.stringify({ ...b, lastCheckedAt: 0 });
}

/** Entries are checked one by one: a bad entry costs only itself (like the workspace). */
function parseFile(text: string): { state: AlertsState; dropped: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = alertsFileSchema.safeParse(json);
  if (!parsed.success) return null;
  let dropped = 0;
  const alerts: Alert[] = [];
  for (const raw of parsed.data.alerts) {
    const a = alertSchema.safeParse(raw);
    if (a.success && ALERT_SYMBOL_RE.test(a.data.symbol) && checkAlertCondition(a.data.condition, { stored: true }) === null) alerts.push(a.data);
    else dropped++;
  }
  const events: AlertEvent[] = [];
  for (const raw of parsed.data.events) {
    const e = alertEventSchema.safeParse(raw);
    if (e.success) events.push(e.data);
    else dropped++;
  }
  events.sort((a, b) => b.firedAt - a.firedAt);
  return { state: { alerts, events: events.slice(0, MAX_ALERT_EVENTS) }, dropped };
}

export async function openAlertsStore(filePath: string, opts: AlertsStoreOptions = {}): Promise<AlertsStore> {
  const fs = opts.fs ?? nodeWorkspaceFs;
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = opts.newId ?? (() => randomUUID());
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const dir = dirname(filePath);
  const listeners = new Set<(message: AlertStreamMessage) => void>();

  async function persist(s: AlertsState): Promise<void> {
    const tmp = join(dir, `.${newId()}.tmp`);
    const text = `${JSON.stringify({ version: ALERTS_FILE_VERSION, ...s })}\n`;
    try {
      await fs.writeFileSynced(tmp, text);
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp).catch(() => undefined);
      throw err;
    }
    await fs.syncDir(dir);
  }

  async function load(): Promise<AlertsState> {
    await fs.mkdir(dir);
    const text = await fs.readFile(filePath);
    if (text !== null) {
      const result = parseFile(text);
      if (result) {
        if (result.dropped > 0) {
          warn(`Alerts file ${filePath}: dropped ${result.dropped} invalid entries.`);
          await persist(result.state);
        }
        return result.state;
      }
      let backup = `${filePath}.corrupt-${clock()}`;
      for (let n = 1; await fs.exists(backup); n++) backup = `${filePath}.corrupt-${clock()}-${n}`;
      await fs.rename(filePath, backup);
      warn(`Alerts file ${filePath} is not valid. Renamed to ${backup}. Starting with no alerts.`);
    }
    const fresh: AlertsState = { alerts: [], events: [] };
    await persist(fresh);
    return fresh;
  }

  let state = await load();
  /** When a check first changed state that is not on disk yet; null when the file is current. */
  let dirtySince: number | null = null;

  /**
   * A listener that throws (a stream socket that closed) must not fail a change that is
   * already saved, or keep the message from the other listeners.
   */
  function broadcast(message: AlertStreamMessage): void {
    for (const l of listeners) {
      try {
        l(structuredClone(message));
      } catch (err) {
        warn(`Alerts stream: a listener failed: ${(err as Error).message}`);
      }
    }
  }

  const flushDue = () => dirtySince !== null && clock() - dirtySince >= STATE_FLUSH_SECONDS;

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  /** Change a copy, persist it, adopt it, then send the stream messages. */
  function mutate<T>(
    change: (draft: AlertsState) => { result: T; messages: AlertStreamMessage[]; write?: boolean; keep?: boolean },
  ): Promise<T> {
    return serial(async () => {
      const draft = structuredClone(state);
      // `keep`: only `lastCheckedAt` moved; it is not worth a write or a dirty mark.
      const { result, messages, write = true, keep = false } = change(draft);
      if (write || flushDue()) {
        await persist(draft);
        dirtySince = null;
      } else if (!keep && dirtySince === null) {
        dirtySince = clock();
      }
      state = draft;
      for (const m of messages) broadcast(m);
      return structuredClone(result);
    });
  }

  const unchecked = (s: AlertsState) => s.events.filter((e) => !e.checked).length;

  function find(s: AlertsState, id: EntityId): Alert {
    const a = s.alerts.find((x) => x.id === id);
    if (!a) throw new ApiFailure('NOT_FOUND', `No alert with id ${id}.`);
    return a;
  }

  return {
    list: () => structuredClone(state.alerts),

    async create(body, origin) {
      const symbol = canonicalSymbol(body.symbol);
      checkFields(body);
      return mutate((s) => {
        const t = clock();
        const expiry = body.expiry ?? DEFAULT_ALERT_EXPIRY;
        const alert: Alert = {
          id: newId(),
          symbol,
          condition: structuredClone(body.condition),
          frequency: body.frequency ?? 'once',
          expiry,
          expiresAt: computeExpiresAt(t, expiry),
          message: body.message ?? '',
          status: 'active',
          revision: 1,
          createdAt: t,
          updatedAt: t,
          state: emptyState(),
          ...(origin ? { origin: structuredClone(origin) } : {}),
        };
        s.alerts.unshift(alert);
        return { result: alert, messages: [{ type: 'alerts' }] };
      });
    },

    async update(id, body) {
      checkFields(body);
      return mutate((s) => {
        const a = find(s, id);
        if (body.revision !== a.revision) throw new ApiFailure('CONFLICT', 'This alert was changed elsewhere. Reload to see the latest version.');
        const t = clock();
        if (body.condition !== undefined) {
          a.condition = structuredClone(body.condition);
          a.state = resetSide(a.state);
        }
        if (body.frequency !== undefined) a.frequency = body.frequency;
        if (body.message !== undefined) a.message = body.message;
        if (body.expiry !== undefined) {
          a.expiry = body.expiry;
          a.expiresAt = computeExpiresAt(t, body.expiry);
          if (a.status === 'expired' && body.status === undefined) a.status = 'active';
        }
        if (body.status !== undefined && body.status !== a.status) {
          if (body.status === 'active') a.state = resetSide(a.state);
          a.status = body.status;
        }
        if (body.status === 'active' && a.expiresAt <= t) a.expiresAt = computeExpiresAt(t, a.expiry);
        a.revision += 1;
        a.updatedAt = t;
        return { result: a, messages: [{ type: 'alerts' }] };
      });
    },

    remove(id) {
      return mutate((s) => {
        const a = find(s, id);
        s.alerts = s.alerts.filter((x) => x.id !== a.id);
        return { result: { id: a.id }, messages: [{ type: 'alerts' }] };
      });
    },

    events(since = 0) {
      return { events: structuredClone(state.events.filter((e) => e.firedAt > since)), unchecked: unchecked(state) };
    },

    setChecked(body) {
      return mutate((s) => {
        const ids = 'ids' in body ? new Set(body.ids) : null;
        for (const e of s.events) if (ids === null || ids.has(e.id)) e.checked = true;
        const n = unchecked(s);
        return { result: { unchecked: n }, messages: [{ type: 'checked', unchecked: n, checkedIds: ids === null ? 'all' : [...ids] }] };
      });
    },

    deleteEvent(id) {
      return mutate((s) => {
        if (!s.events.some((e) => e.id === id)) throw new ApiFailure('NOT_FOUND', `No event with id ${id}.`);
        s.events = s.events.filter((e) => e.id !== id);
        const n = unchecked(s);
        return { result: { unchecked: n }, messages: [{ type: 'checked', unchecked: n, deletedId: id }] };
      });
    },

    applyChecks(checks) {
      return mutate((s) => {
        const fired: AlertEvent[] = [];
        const messages: AlertStreamMessage[] = [];
        let write = false;
        let changed = false;
        let statusChanged = false;
        for (const c of checks) {
          const a = s.alerts.find((x) => x.id === c.alertId);
          // Deleted or edited while the check ran: the user's change wins.
          if (!a || a.revision !== c.revision) continue;
          // A state change alone (the side, the day range, the last bar) is saved within
          // STATE_FLUSH_SECONDS; `lastCheckedAt` alone rides along with the next write.
          if (!sameIgnoringCheckTime(a.state, c.result.state)) changed = true;
          a.state = c.result.state;
          if (a.status !== c.result.status) {
            a.status = c.result.status;
            statusChanged = true;
            write = true;
          }
          for (const f of c.result.fires) {
            const event: AlertEvent = {
              id: newId(),
              alertId: a.id,
              symbol: a.symbol,
              condition: structuredClone(a.condition),
              message: a.message,
              firedAt: clock(),
              crossed: f.crossed,
              value: f.value,
              target: f.target,
              delayed: c.delayed,
              ...(a.condition.type !== 'price' ? { barTime: f.time } : {}),
              checked: false,
              ...(a.origin ? { origin: structuredClone(a.origin) } : {}),
            };
            s.events.unshift(event);
            fired.push(event);
            messages.push({ type: 'fired', event, alert: structuredClone(a) });
            write = true;
          }
        }
        s.events.length = Math.min(s.events.length, MAX_ALERT_EVENTS);
        // `fired` already carries the alert; `alerts` covers an expiry with no event.
        if (statusChanged && fired.length === 0) messages.push({ type: 'alerts' });
        if (!changed && !write) return { result: fired, messages, write: false, keep: true };
        return { result: fired, messages, write };
      });
    },

    flush(force = false) {
      return serial(async () => {
        if (!(flushDue() || (force && dirtySince !== null))) return;
        await persist(state);
        dirtySince = null;
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    publish: broadcast,
  };
}
