/**
 * Thin streaming client for DeepSeek's OpenAI-compatible `/chat/completions`.
 *
 * KEY HANDLING. The key goes in the `Authorization` header only, never in a URL. Every
 * error thrown from here has a fixed message built from the HTTP status. Nothing from the
 * upstream body is copied into a message.
 */
import { ApiFailure } from '../provider/errors';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatClient {
  /** Yields the text deltas of the answer. Throws ApiFailure. */
  stream(messages: readonly ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: FetchLike;
  /** The whole answer must arrive in this time. */
  timeoutMs?: number;
  temperature?: number;
}

const MESSAGES = {
  unauthorized: 'The AI service refused the API key.',
  balance: 'The AI service account has no balance.',
  rateLimited: 'The AI service is busy. Try again in a minute.',
  timeout: 'The AI service did not answer in time.',
  upstream: 'The AI service failed.',
} as const;

function failureFor(status: number): ApiFailure {
  if (status === 401 || status === 403) return new ApiFailure('UNAUTHORIZED', MESSAGES.unauthorized);
  if (status === 402) return new ApiFailure('UNAUTHORIZED', MESSAGES.balance);
  if (status === 429) return new ApiFailure('RATE_LIMITED', MESSAGES.rateLimited, 60);
  return new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
}

export class DeepSeekClient implements ChatClient {
  private readonly fetch: FetchLike;

  constructor(private readonly opts: DeepSeekOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async *stream(messages: readonly ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const both = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ model: this.opts.model, messages, stream: true, temperature: this.opts.temperature ?? 0.2 }),
        signal: both,
      });
    } catch {
      throw timeout.aborted ? new ApiFailure('UPSTREAM_TIMEOUT', MESSAGES.timeout) : new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
    }
    if (!res.ok || !res.body) throw failureFor(res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw timeout.aborted ? new ApiFailure('UPSTREAM_TIMEOUT', MESSAGES.timeout) : new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
        }
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          // Server-sent events: `data: {json}` lines; keep-alive comments start with ':'.
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let parsed: { choices?: { delta?: { content?: string | null } }[] };
          try {
            parsed = JSON.parse(data) as typeof parsed;
          } catch {
            throw new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
          }
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
