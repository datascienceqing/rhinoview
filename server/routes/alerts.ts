/**
 * `/api/alerts` and `/api/alerts/events`, plus the event stream `/api/alerts/stream`.
 * See docs/CONTRACT.md, "Alerts".
 *
 * Bodies are validated with strict zod schemas (unknown fields -> BAD_REQUEST) BEFORE
 * the id is looked up; the store applies the semantic rules and throws ApiFailure.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AlertStreamMessage, ApiResult } from '@shared/types';
import { ALERT_MIN_CHECK_SECONDS } from '@shared/types';
import { createAlertBodySchema, setCheckedBodySchema, updateAlertBodySchema } from '../alerts/schemas';
import type { AlertsStore } from '../alerts/store';
import { ApiFailure, MESSAGES } from '../provider/errors';
import { logUnexpected, sendFailure } from './envelope';

export interface AlertsRouteDeps {
  /** Null means "not available"; the routes then answer INTERNAL "not implemented". */
  store: AlertsStore | null;
  /** Interval of the SSE comment that keeps proxies from closing an idle stream. */
  heartbeatMs?: number;
  /** The checker's current interval; without a checker the answer is ALERT_MIN_CHECK_SECONDS. */
  checkIntervalSeconds?: () => number;
}

/** Keeps idle connections open through proxies that close a silent stream. */
export const SSE_HEARTBEAT_MS = 25_000;

const eventsQuery = z.object({ since: z.string().regex(/^\d{1,12}$/, 'since must be Unix seconds.').optional() }).strict();

function parse<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new ApiFailure('BAD_REQUEST', `Invalid ${what}. ${where}${issue?.message ?? ''}`.trim());
}

/** One SSE message: the event name is the message type, the data is the message as JSON. */
export function sseFrame(message: AlertStreamMessage): string {
  return `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}

export function registerAlertsRoutes(app: FastifyInstance, deps: AlertsRouteDeps): void {
  async function respond<T>(reply: FastifyReply, status: number, body: (store: AlertsStore) => T | Promise<T>) {
    try {
      if (!deps.store) throw new ApiFailure('INTERNAL', 'Alerts storage is not implemented.');
      const data = await body(deps.store);
      return await reply.code(status).send({ ok: true, data } satisfies ApiResult<T>);
    } catch (err) {
      if (err instanceof ApiFailure) return sendFailure(reply, err);
      logUnexpected(reply.log, err);
      return sendFailure(reply, new ApiFailure('INTERNAL', MESSAGES.internal));
    }
  }

  const idOf = (req: { params: unknown }) => String((req.params as { id: string }).id);

  app.get('/api/alerts', (_req, reply) =>
    respond(reply, 200, (s) => ({ alerts: s.list(), checkIntervalSeconds: deps.checkIntervalSeconds?.() ?? ALERT_MIN_CHECK_SECONDS })),
  );
  app.post('/api/alerts', (req, reply) =>
    respond(reply, 201, (s) => s.create(parse(createAlertBodySchema, req.body, 'request body'))),
  );

  // Static paths first in reading order; Fastify's router also prefers them over `:id`.
  app.get('/api/alerts/events', (req, reply) =>
    respond(reply, 200, (s) => {
      const { since } = parse(eventsQuery, req.query, 'query');
      return s.events(since === undefined ? undefined : Number(since));
    }),
  );
  app.put('/api/alerts/events/checked', (req, reply) =>
    respond(reply, 200, (s) => s.setChecked(parse(setCheckedBodySchema, req.body, 'request body'))),
  );
  app.delete('/api/alerts/events/:id', (req, reply) => respond(reply, 200, (s) => s.deleteEvent(idOf(req))));

  app.get('/api/alerts/stream', (req, reply) => {
    const store = deps.store;
    if (!store) return sendFailure(reply, new ApiFailure('INTERNAL', 'Alerts storage is not implemented.'));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx and similar proxies buffer responses unless told not to.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = store.subscribe((message) => res.write(sseFrame(message)));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), deps.heartbeatMs ?? SSE_HEARTBEAT_MS);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', close);
    res.on('error', close);
    return undefined;
  });

  app.put('/api/alerts/:id', (req, reply) =>
    respond(reply, 200, (s) => s.update(idOf(req), parse(updateAlertBodySchema, req.body, 'request body'))),
  );
  app.delete('/api/alerts/:id', (req, reply) => respond(reply, 200, (s) => s.remove(idOf(req))));
}
