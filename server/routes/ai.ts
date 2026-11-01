/**
 * `POST /api/ai/analyze` (docs/CONTRACT.md, AI helper; docs/AI_HELPER_PLAN.md, step B), and
 * `POST /api/ai/alerts` (step D), and `POST /api/ai/explain` (step E, at the end of this file).
 *
 * 1. Validate the body, check the daily limit, and build the facts. A failure here is a
 *    normal envelope with its HTTP status, and it costs no DeepSeek call.
 * 2. Then the reply becomes a `text/event-stream`: `facts`, the `delta` events of the
 *    model answer, and `done` with the number check (or `error`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MAX_AI_QUESTION_LENGTH } from '@shared/types';
import type { AiAlertsResponse, AiAnalyzeEvent, AiMarks, Alert } from '@shared/types';
import type { AlertsStore } from '../alerts/store';
import { buildAiAlerts } from '../ai/alerts';
import type { AnalysesStore } from '../ai/analyses';
import { explainFacts, planMarks, savedPlan, statusOf } from '../ai/explain';
import { redact } from '../env';
import { buildFacts } from '../ai/facts/build';
import type { Facts } from '../ai/facts/build';
import type { ChatClient } from '../ai/deepseek';
import { loadFactsInput } from '../ai/load';
import type { LoadDeps } from '../ai/load';
import { checkNumbers } from '../ai/numberCheck';
import { loadSkill } from '../ai/skills';
import type { SkillName } from '../ai/skills';
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
const explainBody = z.object({ eventId: z.string().trim().min(1, 'must not be empty').max(100) }).strict();

/** The question of an explanation request. The facts are built for it, and the panel shows it. */
export const AI_EXPLAIN_QUESTION = 'Explain the alert that fired.';
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

/**
 * Sends the `facts` event, then streams the model answer with `skill`, then `done` with the
 * number check of the answer against `facts.facts` (or `error`).
 */
async function streamAnswer(
  req: FastifyRequest,
  reply: FastifyReply,
  client: ChatClient,
  skillName: SkillName,
  input: unknown,
  facts: { symbol: string; facts: Record<string, unknown>; marks: AiMarks },
): Promise<void> {
  const skill = await loadSkill(skillName);
  // From here on the reply is a stream; failures become an `error` event.
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  send(reply, { type: 'facts', ...facts });

  const abort = new AbortController();
  reply.raw.on('close', () => abort.abort());
  let text = '';
  try {
    const messages = [
      { role: 'system' as const, content: skill.body },
      { role: 'user' as const, content: JSON.stringify(input) },
    ];
    for await (const delta of client.stream(messages, abort.signal)) {
      text += delta;
      send(reply, { type: 'delta', text: delta });
    }
    send(reply, { type: 'done', text, check: checkNumbers(text, facts.facts) });
  } catch (err) {
    if (!abort.signal.aborted) {
      const failure = err instanceof ApiFailure ? err : new ApiFailure('INTERNAL', MESSAGES.internal);
      if (!(err instanceof ApiFailure)) req.log.error({ cause: redact(String(err)) }, 'ai stream failed');
      send(reply, { type: 'error', error: failure.toApiError() });
    }
  } finally {
    reply.raw.end();
  }
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
    const { marks, ...rest } = facts;
    await streamAnswer(req, reply, client, 'trade-check', { question, facts: rest }, { symbol: facts.symbol, facts: rest as unknown as Record<string, unknown>, marks });
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

  /**
   * The explanation of a fired AI alert (docs/AI_HELPER_PLAN.md, step E). The server finds
   * the saved plan, builds new facts, and calculates the trigger kind and the status. The
   * model explains them with the `alert-explain` skill.
   */
  app.post('/api/ai/explain', async (req, reply) => {
    const { client, alerts, analyses } = deps;
    if (!client || !alerts || !analyses) return sendFailure(reply, new ApiFailure('INTERNAL', 'The AI helper is not configured.'));
    const parsed = explainBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendFailure(reply, new ApiFailure('BAD_REQUEST', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`));
    }
    const event = alerts.events().events.find((e) => e.id === parsed.data.eventId);
    if (!event) return sendFailure(reply, new ApiFailure('NOT_FOUND', `No event with id ${parsed.data.eventId}.`));
    const origin = event.origin;
    if (!origin) return sendFailure(reply, new ApiFailure('BAD_REQUEST', 'This event is not from an AI alert.'));
    const analysis = analyses.get(origin.analysisId);
    const saved = analysis?.facts as Facts | undefined;
    const plan = saved ? savedPlan(saved, origin.plan) : null;
    if (!analysis || !saved || !plan) return sendFailure(reply, new ApiFailure('NOT_FOUND', 'The analysis of this alert is not saved.'));

    let input: Awaited<ReturnType<typeof loadFactsInput>>;
    let now: Facts;
    try {
      input = await loadFactsInput(deps, event.symbol, AI_EXPLAIN_QUESTION);
      now = buildFacts(input);
    } catch (err) {
      const failure = mapEngineError(err);
      if (failure.code === 'UPSTREAM_ERROR' || failure.code === 'INTERNAL') req.log.error({ cause: redact(String(err)) }, 'ai facts failed');
      return sendFailure(reply, failure);
    }
    if (!counter.take()) {
      return sendFailure(reply, new ApiFailure('RATE_LIMITED', 'The daily limit of AI requests is reached. Try again tomorrow.'));
    }
    const nowTime = deps.now();
    const status = statusOf({ role: origin.role, plan, level: event.target, firedAt: event.firedAt, now: nowTime, bars4h: input.bars['4h'], bars1d: input.bars['1D'] });
    const facts = explainFacts({ event, origin, analysisAt: analysis.createdAt, saved, plan, status, now, nowTime });
    await streamAnswer(req, reply, client, 'alert-explain', { question: AI_EXPLAIN_QUESTION, facts }, {
      symbol: event.symbol, facts: facts as unknown as Record<string, unknown>, marks: planMarks(saved, origin.plan),
    });
  });
}
