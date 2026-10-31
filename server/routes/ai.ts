/**
 * `POST /api/ai/analyze` (docs/CONTRACT.md, AI helper; docs/AI_HELPER_PLAN.md, step B), and
 * `POST /api/ai/alerts` (step D, at the end of this file).
 *
 * 1. Validate the body, check the daily limit, and build the facts. A failure here is a
 *    normal envelope with its HTTP status, and it costs no DeepSeek call.
 * 2. Then the reply becomes a `text/event-stream`: `facts`, the `delta` events of the
 *    model answer, and `done` with the number check (or `error`).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MAX_AI_QUESTION_LENGTH } from '@shared/types';
import type { AiAlertsResponse, AiAnalyzeEvent, Alert } from '@shared/types';
import type { AlertsStore } from '../alerts/store';
import { buildAiAlerts } from '../ai/alerts';
import type { AnalysesStore } from '../ai/analyses';
import { redact } from '../env';
import { buildFacts } from '../ai/facts/build';
import type { ChatClient } from '../ai/deepseek';
import { loadFactsInput } from '../ai/load';
import type { LoadDeps } from '../ai/load';
import { checkNumbers } from '../ai/numberCheck';
import { loadSkill } from '../ai/skills';
import { ApiFailure, MESSAGES, mapEngineError } from '../provider/errors';
import { respond, sendFailure } from './envelope';

export interface AiRouteDeps extends LoadDeps {
  /** Null when no DeepSeek key is configured: the endpoint answers "not available". */
  client: ChatClient | null;
  dailyLimit: number;
  /** Null: `POST /api/ai/alerts` answers "not available". */
  alerts: AlertsStore | null;
  analyses: AnalysesStore | null;
}

/** The question saved with the facts of an AI alerts request. It has no direction, so both sides are planned. */
export const AI_ALERTS_QUESTION = 'Which alerts are useful now?';

const symbolField = z.string().trim().regex(/^[A-Za-z0-9.^=-]{1,16}$/, 'must be 1-16 characters: letters, digits, ".", "^", "=" or "-"');
const alertsBody = z.object({ symbol: symbolField }).strict();
const body = z.object({
  symbol: symbolField,
  question: z.string().trim().min(1, 'must not be empty').max(MAX_AI_QUESTION_LENGTH, `must be at most ${MAX_AI_QUESTION_LENGTH} characters`),
});

/** Calls a day, counted per New York day. In memory: a restart starts the count again. */
export class DailyCounter {
  private day = '';
  private count = 0;

  constructor(private readonly limit: number, private readonly now: () => number) {}

  /** Counts one call. False when the limit is reached. */
  take(): boolean {
    const today = new Date(this.now() * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}

function send(reply: FastifyReply, event: AiAnalyzeEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const counter = new DailyCounter(deps.dailyLimit, deps.now);

  app.post('/api/ai/analyze', async (req, reply) => {
    const client = deps.client;
    if (!client) return sendFailure(reply, new ApiFailure('INTERNAL', 'The AI helper is not configured.'));
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendFailure(reply, new ApiFailure('BAD_REQUEST', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`));
    }
    const { symbol, question } = parsed.data;

    let facts: ReturnType<typeof buildFacts>;
    try {
      facts = buildFacts(await loadFactsInput(deps, symbol, question));
    } catch (err) {
      const failure = mapEngineError(err);
      if (failure.code === 'UPSTREAM_ERROR' || failure.code === 'INTERNAL') req.log.error({ cause: redact(String(err)) }, 'ai facts failed');
      return sendFailure(reply, failure);
    }
    // Count only the requests that reach DeepSeek.
    if (!counter.take()) {
      return sendFailure(reply, new ApiFailure('RATE_LIMITED', 'The daily limit of AI requests is reached. Try again tomorrow.'));
    }
    const skill = await loadSkill('trade-check');

    // From here on the reply is a stream; failures become an `error` event.
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const { marks, ...rest } = facts;
    send(reply, { type: 'facts', symbol: facts.symbol, facts: rest as unknown as Record<string, unknown>, marks });

    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    let text = '';
    try {
      const messages = [
        { role: 'system' as const, content: skill.body },
        { role: 'user' as const, content: JSON.stringify({ question, facts: rest }) },
      ];
      for await (const delta of client.stream(messages, abort.signal)) {
        text += delta;
        send(reply, { type: 'delta', text: delta });
      }
      send(reply, { type: 'done', text, check: checkNumbers(text, rest) });
    } catch (err) {
      if (!abort.signal.aborted) {
        const failure = err instanceof ApiFailure ? err : new ApiFailure('INTERNAL', MESSAGES.internal);
        if (!(err instanceof ApiFailure)) req.log.error({ cause: redact(String(err)) }, 'ai stream failed');
        send(reply, { type: 'error', error: failure.toApiError() });
      }
    } finally {
      reply.raw.end();
    }
  });

  /**
   * Price alerts from the featured plans (docs/AI_HELPER_PLAN.md, step D). No model call: the
   * plans are already calculated. The facts are saved for the explanation of step E.
   */
  app.post('/api/ai/alerts', (req, reply) =>
    respond(reply, async (): Promise<AiAlertsResponse> => {
      const { alerts, analyses } = deps;
      if (!alerts || !analyses) throw new ApiFailure('INTERNAL', 'AI alerts are not available.');
      const parsed = alertsBody.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiFailure('BAD_REQUEST', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      }
      let facts: ReturnType<typeof buildFacts>;
      try {
        facts = buildFacts(await loadFactsInput(deps, parsed.data.symbol, AI_ALERTS_QUESTION));
      } catch (err) {
        throw mapEngineError(err);
      }
      const analysisId = randomUUID();
      const { candidates, rejected } = buildAiAlerts(facts, alerts.list(), deps.now(), analysisId);
      const added: Alert[] = [];
      for (const c of candidates) added.push(await alerts.create(c.body, c.origin));
      await analyses.save({
        id: analysisId, symbol: facts.symbol, createdAt: deps.now(), question: AI_ALERTS_QUESTION,
        facts: facts as unknown as Record<string, unknown>, text: null, alertIds: added.map((a) => a.id),
      });
      return { analysisId, symbol: facts.symbol, added, rejected, synthetic: facts.synthetic };
    }),
  );
}
