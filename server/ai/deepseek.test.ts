import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../provider/errors';
import { DeepSeekClient } from './deepseek';
import type { FetchLike } from './deepseek';

const KEY = 'sk-deepseek-SECRET-1234';

/** A streamed response whose body arrives in the given pieces. */
function streamed(pieces: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, { status });
}

const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function collect(client: DeepSeekClient): Promise<string[]> {
  const out: string[] = [];
  for await (const t of client.stream([{ role: 'user', content: 'hi' }], new AbortController().signal)) out.push(t);
  return out;
}

describe('DeepSeekClient', () => {
  it('yields the deltas, also when a line is split across chunks', async () => {
    const whole = `: keep-alive\n\n${chunk('Short')}${chunk(' answer')}data: [DONE]\n\n${chunk('ignored')}`;
    const fetch = vi.fn<FetchLike>(async () => streamed([whole.slice(0, 30), whole.slice(30, 61), whole.slice(61)]));
    const client = new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', fetch });
    expect(await collect(client)).toEqual(['Short', ' answer']);
  });

  it('sends the key in the header only', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed(['data: [DONE]\n\n']));
    await collect(new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', fetch }));
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(url).not.toContain(KEY);
    expect(init?.body).not.toContain(KEY);
    expect(init?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({ model: 'deepseek-chat', stream: true });
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [402, 'UNAUTHORIZED'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_ERROR'],
  ])('maps HTTP %i to %s with a fixed message', async (status, code) => {
    const fetch = vi.fn<FetchLike>(async () => new Response(`bad key ${KEY}`, { status }));
    const err = await collect(new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://x', model: 'm', fetch, retryDelayMs: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe(code);
    expect((err as ApiFailure).message).not.toContain(KEY);
  });

  it('maps a network failure to UPSTREAM_ERROR', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError(`connect failed https://x?key=${KEY}`);
    });
    const err = await collect(new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://x', model: 'm', fetch, retryDelayMs: 1 })).catch((e: unknown) => e);
    expect((err as ApiFailure).code).toBe('UPSTREAM_ERROR');
    expect((err as ApiFailure).message).not.toContain(KEY);
  });

  const raw = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  const DONE = 'data: [DONE]\n\n';
  /** A body that sends the pieces and then stays open. */
  function hanging(pieces: string[]): Response {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({ start: (c) => pieces.forEach((p) => c.enqueue(enc.encode(p))) }), { status: 200 });
  }
  const make = (fetch: FetchLike, more: Partial<ConstructorParameters<typeof DeepSeekClient>[0]> = {}) =>
    new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://x', model: 'deepseek-flash', fetch, retryDelayMs: 1, ...more });
  const sentBody = (fetch: ReturnType<typeof vi.fn<FetchLike>>) => JSON.parse(fetch.mock.calls[0]?.[1].body ?? '{}') as Record<string, unknown>;

  it('turns thinking off by default, and sends the temperature', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed([DONE]));
    await collect(make(fetch));
    expect(sentBody(fetch)).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.2 });
    expect(sentBody(fetch)).not.toHaveProperty('reasoning_effort');
  });

  it('sends the thinking effort, and no temperature', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed([DONE]));
    await collect(make(fetch, { thinking: 'high' }));
    expect(sentBody(fetch)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(sentBody(fetch)).not.toHaveProperty('temperature');
  });

  it('lets one call override the thinking effort', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed([DONE]));
    const client = make(fetch, { thinking: 'high' });
    for await (const _ of client.stream([{ role: 'user', content: 'hi' }], new AbortController().signal, { thinking: 'off' })) void _;
    expect(sentBody(fetch)).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('does not yield the thinking text', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      streamed([raw({ choices: [{ delta: { reasoning_content: 'I think…' } }] }), chunk('Answer'), raw({ choices: [{ delta: {}, finish_reason: 'stop' }] }), DONE]),
    );
    expect(await collect(make(fetch))).toEqual(['Answer']);
  });

  it.each([
    ['length', 'UPSTREAM_ERROR', 'length limit'],
    ['content_filter', 'UPSTREAM_ERROR', 'stopped the answer'],
    ['insufficient_system_resource', 'RATE_LIMITED', 'busy'],
  ])('fails when the finish reason is %s', async (reason, code, words) => {
    const fetch = vi.fn<FetchLike>(async () => streamed([chunk('Part'), raw({ choices: [{ delta: {}, finish_reason: reason }] }), DONE]));
    const out: string[] = [];
    const err = await (async () => {
      for await (const t of make(fetch).stream([{ role: 'user', content: 'hi' }], new AbortController().signal)) out.push(t);
    })().catch((e: unknown) => e);
    expect(out).toEqual(['Part']);
    expect((err as ApiFailure).code).toBe(code);
    expect((err as ApiFailure).message).toContain(words);
  });

  it('fails when the stream closes without [DONE]', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed([chunk('Part')]));
    const err = await collect(make(fetch)).catch((e: unknown) => e);
    expect((err as ApiFailure).code).toBe('UPSTREAM_ERROR');
    expect((err as ApiFailure).message).toContain('not complete');
  });

  it('accepts a stream that closes after the finish reason stop', async () => {
    const fetch = vi.fn<FetchLike>(async () => streamed([chunk('All'), raw({ choices: [{ delta: {}, finish_reason: 'stop' }] })]));
    expect(await collect(make(fetch))).toEqual(['All']);
  });

  it('tries a 500 one more time, and reports it', async () => {
    const onFailure = vi.fn();
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(new Response(`oops ${KEY}`, { status: 500 })).mockResolvedValueOnce(streamed([chunk('ok'), DONE]));
    expect(await collect(make(fetch, { onFailure }))).toEqual(['ok']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith({ status: 500, detail: `oops ${KEY}`, retried: true });
  });

  it('tries only two times', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('', { status: 503 }));
    const err = await collect(make(fetch)).catch((e: unknown) => e);
    expect((err as ApiFailure).code).toBe('UPSTREAM_ERROR');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not try a rejected request again, and reports the status', async () => {
    const onFailure = vi.fn();
    const fetch = vi.fn<FetchLike>(async () => new Response('{"error":{"message":"Model Not Exist"}}', { status: 400 }));
    const err = await collect(make(fetch, { onFailure })).catch((e: unknown) => e);
    expect((err as ApiFailure).message).toContain('DEEPSEEK_MODEL');
    expect((err as ApiFailure).message).not.toContain('Model Not Exist');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ status: 400, detail: '{"error":{"message":"Model Not Exist"}}', retried: false });
  });

  it('stops when the first token is late; keep-alive lines do not count', async () => {
    const fetch = vi.fn<FetchLike>(async () => hanging([': keep-alive\n\n']));
    const err = await collect(make(fetch, { firstTokenTimeoutMs: 20 })).catch((e: unknown) => e);
    expect((err as ApiFailure).code).toBe('UPSTREAM_TIMEOUT');
  });

  it('stops when the stream is silent for too long', async () => {
    const fetch = vi.fn<FetchLike>(async () => hanging([chunk('Start')]));
    const out: string[] = [];
    const err = await (async () => {
      for await (const t of make(fetch, { firstTokenTimeoutMs: 5_000, idleTimeoutMs: 20 }).stream([{ role: 'user', content: 'hi' }], new AbortController().signal)) out.push(t);
    })().catch((e: unknown) => e);
    expect(out).toEqual(['Start']);
    expect((err as ApiFailure).code).toBe('UPSTREAM_TIMEOUT');
  });
});
