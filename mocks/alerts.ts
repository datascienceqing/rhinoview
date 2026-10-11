/**
 * MSW mock of the alerts endpoints (docs/CONTRACT.md, "Alerts").
 *
 * It implements the whole contract as strictly as the server: the server's strict zod
 * schemas, the same condition and message checks, limits, revision conflicts, not-found.
 * It has no checker: tests and the dev app fire an alert with `mockFireAlert`, which also
 * pushes a `fired` message to every open stream.
 */
import { http } from 'msw';
import type { ZodType } from 'zod';
import type {
  Alert,
  AlertEvent,
  AlertStreamMessage,
  ApiErrorCode,
  CreateAlertBody,
  SetCheckedBody,
  UpdateAlertBody,
} from '@shared/types';
import { DEFAULT_ALERT_EXPIRY, MAX_ALERT_EVENTS, MAX_ALERTS } from '@shared/types';
import { createAlertBodySchema, setCheckedBodySchema, updateAlertBodySchema } from '../server/alerts/schemas';
import { ALERT_SYMBOL_RE, checkAlertCondition, checkAlertMessage } from '../src/alerts/condition';
import { computeExpiresAt } from '../src/alerts/expiry';
import { fail, ok } from './envelope';

let seq = 0;
let clock = 1_790_000_000;
const nextId = (p: string) => `${p}_${(++seq).toString(36)}`;
const now = () => ++clock;

let alerts: Alert[] = [];
/** Newest first. */
let events: AlertEvent[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

/** Tests: restore the empty state. Call in beforeEach. */
export function resetMockAlerts(next?: { alerts?: Alert[]; events?: AlertEvent[] }): void {
  alerts = structuredClone(next?.alerts ?? []);
  events = structuredClone(next?.events ?? []);
}

/** Tests: read the mock's current state. */
export function mockAlerts(): { alerts: Alert[]; events: AlertEvent[] } {
  return structuredClone({ alerts, events });
}

function broadcast(message: AlertStreamMessage): void {
  const chunk = encoder.encode(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
  for (const c of streams) {
    try {
      c.enqueue(chunk);
    } catch {
      streams.delete(c);
    }
  }
}

const uncheckedCount = () => events.filter((e) => !e.checked).length;

/**
 * Tests and dev: fire alert `id` as the server checker would, at `value` against `target`.
 * A `once` alert becomes `triggered`. Returns the new event.
 */
export function mockFireAlert(id: string, value: number, target: number, crossed: 'up' | 'down' = 'up'): AlertEvent {
  const alert = alerts.find((a) => a.id === id);
  if (!alert) throw new Error(`mockFireAlert: no alert ${id}`);
  const t = now();
  alert.state = { ...alert.state, firedCount: alert.state.firedCount + 1, lastFiredAt: t, lastCheckedAt: t };
  if (alert.frequency === 'once') alert.status = 'triggered';
  const event: AlertEvent = {
    id: nextId('evt'),
    alertId: alert.id,
    symbol: alert.symbol,
    condition: structuredClone(alert.condition),
    message: alert.message,
    firedAt: t,
    crossed,
    value,
    target,
    delayed: false,
    checked: false,
  };
  events.unshift(event);
  events.length = Math.min(events.length, MAX_ALERT_EVENTS);
  broadcast({ type: 'fired', event: structuredClone(event), alert: structuredClone(alert) });
  return structuredClone(event);
}

class Reject extends Error {
  constructor(public code: ApiErrorCode, message: string) {
    super(message);
  }
}

async function handle<T>(fn: () => T | Promise<T>, status = 200) {
  try {
    return ok(await fn(), status);
  } catch (e) {
    if (e instanceof Reject) return fail({ code: e.code, message: e.message });
    throw e;
  }
}

const body = async <T>(request: Request, schema: ZodType<T>): Promise<T> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new Reject('BAD_REQUEST', 'Malformed JSON body.');
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new Reject('BAD_REQUEST', `Invalid request body. ${parsed.error.issues[0]?.message ?? ''}`.trim());
  return parsed.data;
};

function checkFields(b: Pick<UpdateAlertBody, 'condition' | 'message'>): void {
  const conditionError = b.condition ? checkAlertCondition(b.condition) : null;
  if (conditionError !== null) throw new Reject('BAD_REQUEST', `Invalid condition: ${conditionError}`);
  const messageError = b.message !== undefined ? checkAlertMessage(b.message) : null;
  if (messageError !== null) throw new Reject('BAD_REQUEST', messageError);
}

function find(id: string): Alert {
  const a = alerts.find((x) => x.id === id);
  if (!a) throw new Reject('NOT_FOUND', `No alert with id ${id}.`);
  return a;
}

const newState = (): Alert['state'] => ({
  lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null,
});

function sseResponse(): Response {
  let self: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      streams.add(controller);
      controller.enqueue(encoder.encode(': connected\n\n'));
    },
    cancel() {
      if (self) streams.delete(self);
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

export function createAlertsHandlers() {
  return [
    http.get('*/api/alerts', () => handle(() => ({ alerts: structuredClone(alerts) }))),

    http.post('*/api/alerts', ({ request }) =>
      handle(async () => {
        const b: CreateAlertBody = await body(request, createAlertBodySchema);
        if (!ALERT_SYMBOL_RE.test(b.symbol)) throw new Reject('BAD_REQUEST', 'Invalid symbol.');
        checkFields(b);
        if (alerts.length >= MAX_ALERTS) throw new Reject('BAD_REQUEST', `At most ${MAX_ALERTS} alerts.`);
        const t = now();
        const expiry = b.expiry ?? DEFAULT_ALERT_EXPIRY;
        const alert: Alert = {
          id: nextId('alr'),
          symbol: b.symbol.toUpperCase(),
          condition: b.condition,
          frequency: b.frequency ?? 'once',
          expiry,
          expiresAt: computeExpiresAt(t, expiry),
          message: b.message ?? '',
          status: 'active',
          revision: 1,
          createdAt: t,
          updatedAt: t,
          state: newState(),
        };
        alerts.unshift(alert);
        broadcast({ type: 'alerts' });
        return structuredClone(alert);
      }, 201),
    ),

    // Registered before `/api/alerts/:id`, so `events` is never read as an id.
    http.get('*/api/alerts/events', ({ request }) =>
      handle(() => {
        const raw = new URL(request.url).searchParams.get('since');
        let since = 0;
        if (raw !== null) {
          if (!/^\d+$/.test(raw)) throw new Reject('BAD_REQUEST', 'since must be Unix seconds.');
          since = Number(raw);
        }
        return { events: structuredClone(events.filter((e) => e.firedAt > since)), unchecked: uncheckedCount() };
      }),
    ),

    http.put('*/api/alerts/events/checked', ({ request }) =>
      handle(async () => {
        const b: SetCheckedBody = await body(request, setCheckedBodySchema);
        const ids = 'ids' in b ? new Set(b.ids) : null;
        for (const e of events) if (ids === null || ids.has(e.id)) e.checked = true;
        const unchecked = uncheckedCount();
        broadcast({ type: 'checked', unchecked });
        return { unchecked };
      }),
    ),

    http.delete('*/api/alerts/events/:id', ({ params }) =>
      handle(() => {
        const id = String(params.id);
        if (!events.some((e) => e.id === id)) throw new Reject('NOT_FOUND', `No event with id ${id}.`);
        events = events.filter((e) => e.id !== id);
        const unchecked = uncheckedCount();
        broadcast({ type: 'checked', unchecked });
        return { unchecked };
      }),
    ),

    http.get('*/api/alerts/stream', () => sseResponse()),

    http.put('*/api/alerts/:id', ({ request, params }) =>
      handle(async () => {
        const b: UpdateAlertBody = await body(request, updateAlertBodySchema);
        checkFields(b);
        const a = find(String(params.id));
        if (b.revision !== a.revision) throw new Reject('CONFLICT', 'This alert was changed elsewhere.');
        const t = now();
        if (b.condition !== undefined) {
          a.condition = b.condition;
          a.state = { ...a.state, lastSide: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null };
        }
        if (b.frequency !== undefined) a.frequency = b.frequency;
        if (b.message !== undefined) a.message = b.message;
        if (b.expiry !== undefined) {
          a.expiry = b.expiry;
          a.expiresAt = computeExpiresAt(t, b.expiry);
        }
        if (b.status !== undefined && b.status !== a.status) {
          if (b.status === 'active') a.state = { ...a.state, lastSide: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null };
          a.status = b.status;
        }
        // Enabled again after its expiry time: the expiry choice counts from now.
        if (b.status === 'active' && a.expiresAt <= t) a.expiresAt = computeExpiresAt(t, a.expiry);
        // An expired alert with a new expiry in the future is active again.
        if (a.status === 'expired' && b.expiry !== undefined && b.status === undefined) a.status = 'active';
        a.revision += 1;
        a.updatedAt = t;
        broadcast({ type: 'alerts' });
        return structuredClone(a);
      }),
    ),

    http.delete('*/api/alerts/:id', ({ params }) =>
      handle(() => {
        const a = find(String(params.id));
        alerts = alerts.filter((x) => x.id !== a.id);
        broadcast({ type: 'alerts' });
        return { id: a.id };
      }),
    ),
  ];
}
