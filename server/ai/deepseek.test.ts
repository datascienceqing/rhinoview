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
    const err = await collect(new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://x', model: 'm', fetch })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe(code);
    expect((err as ApiFailure).message).not.toContain(KEY);
  });

  it('maps a network failure to UPSTREAM_ERROR', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError(`connect failed https://x?key=${KEY}`);
    });
    const err = await collect(new DeepSeekClient({ apiKey: KEY, baseUrl: 'https://x', model: 'm', fetch })).catch((e: unknown) => e);
    expect((err as ApiFailure).code).toBe('UPSTREAM_ERROR');
    expect((err as ApiFailure).message).not.toContain(KEY);
  });
});
