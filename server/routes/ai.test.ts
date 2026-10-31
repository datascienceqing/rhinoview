/**
 * `POST /api/ai/analyze`: the checks before the stream, and the stream itself, with a fake
 * model on the synthetic engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiAnalyzeEvent, ApiResult, Capabilities } from '@shared/types';
import { buildServer } from '../index';
import { createSyntheticEngine } from '../market';
import type { ChatClient } from '../ai/deepseek';
import { ApiFailure } from '../provider/errors';
import { DailyCounter } from './ai';

const NOW = Date.UTC(2026, 9, 16, 16) / 1000;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeClient(pieces: string[], fail?: ApiFailure): ChatClient & { calls: number; lastUser: string } {
  const c = {
    calls: 0,
    lastUser: '',
    async *stream(messages: readonly { role: string; content: string }[]) {
      c.calls++;
      c.lastUser = messages.find((m) => m.role === 'user')?.content ?? '';
      for (const p of pieces) yield p;
      if (fail) throw fail;
    },
  };
  return c;
}

function server(client: ChatClient | null, dailyLimit = 5) {
  app = buildServer({ engine: createSyntheticEngine(), now: () => NOW, provider: 'synthetic', ai: { client, dailyLimit } });
  return app;
}

const events = (payload: string): AiAnalyzeEvent[] =>
  payload.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as AiAnalyzeEvent);

const analyze = (a: FastifyInstance, body: unknown) => a.inject({ method: 'POST', url: '/api/ai/analyze', payload: body as object });

describe('POST /api/ai/analyze', () => {
  it('streams the facts, the deltas, and the number check', async () => {
    const client = fakeClient(['No — ', 'the R:R is 98765.43:1.']);
    const res = await analyze(server(client), { symbol: 'aapl', question: 'Can I short AAPL here?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const ev = events(res.payload);
    expect(ev.map((e) => e.type)).toEqual(['facts', 'delta', 'delta', 'done']);
    const facts = ev[0];
    expect(facts?.type === 'facts' && facts.symbol).toBe('AAPL');
    expect(facts?.type === 'facts' && facts.facts.direction).toBe('short');
    expect(facts?.type === 'facts' && facts.facts.synthetic).toBe(true);
    const done = ev[3];
    expect(done?.type === 'done' && done.text).toBe('No — the R:R is 98765.43:1.');
    expect(done?.type === 'done' && done.check.unknown).toEqual(['98765.43']);
    // The model gets the question and the facts, and nothing else.
    expect(Object.keys(JSON.parse(client.lastUser) as object)).toEqual(['question', 'facts']);
  });

  it('sends a model failure as an error event', async () => {
    const res = await analyze(server(fakeClient(['Part'], new ApiFailure('UNAUTHORIZED', 'The AI service refused the API key.'))), { symbol: 'AAPL', question: 'Buy?' });
    const ev = events(res.payload);
    expect(ev.map((e) => e.type)).toEqual(['facts', 'delta', 'error']);
    expect(ev[2]?.type === 'error' && ev[2].error.code).toBe('UNAUTHORIZED');
  });

  it('answers "not configured" without a key, and capabilities say ai: false', async () => {
    const a = server(null);
    const res = await analyze(a, { symbol: 'AAPL', question: 'Buy?' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as ApiResult<never>).ok).toBe(false);
    const caps = (await a.inject('/api/capabilities')).json() as ApiResult<Capabilities>;
    expect(caps.ok && caps.data.ai).toBe(false);
  });

  it('reports ai: true with a client', async () => {
    const caps = (await server(fakeClient([])).inject('/api/capabilities')).json() as ApiResult<Capabilities>;
    expect(caps.ok && caps.data.ai).toBe(true);
  });

  it('rejects a bad body and an unknown symbol before any model call', async () => {
    const client = fakeClient(['x']);
    const a = server(client);
    expect((await analyze(a, { symbol: 'AAPL', question: '' })).statusCode).toBe(400);
    expect((await analyze(a, { symbol: 'AAPL', question: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await analyze(a, { symbol: 'NOPE$', question: 'Buy?' })).statusCode).toBe(400);
    expect((await analyze(a, { symbol: 'ZZZZQ', question: 'Buy?' })).statusCode).toBe(404);
    expect(client.calls).toBe(0);
  });

  it('stops at the daily limit', async () => {
    const a = server(fakeClient(['ok']), 1);
    expect((await analyze(a, { symbol: 'AAPL', question: 'Buy?' })).statusCode).toBe(200);
    const res = await analyze(a, { symbol: 'AAPL', question: 'Buy?' });
    expect(res.statusCode).toBe(429);
  });
});

describe('DailyCounter', () => {
  it('starts again on a new New York day', () => {
    let now = Date.UTC(2026, 9, 16, 3) / 1000; // Oct 15, 23:00 New York
    const c = new DailyCounter(1, () => now);
    expect(c.take()).toBe(true);
    expect(c.take()).toBe(false);
    now += 2 * 3600; // Oct 16, 01:00 New York
    expect(c.take()).toBe(true);
  });
});

describe('the key', () => {
  it('is never in a response', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-never-in-a-response');
    const res = await analyze(server(fakeClient(['ok'])), { symbol: 'AAPL', question: 'Buy?' });
    expect(res.payload).not.toContain('sk-never-in-a-response');
    vi.unstubAllEnvs();
  });
});
