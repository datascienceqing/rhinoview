/**
 * Thin streaming client for DeepSeek's OpenAI-compatible `/chat/completions`.
 *
 * KEY HANDLING. The key goes in the `Authorization` header only, never in a URL. Every
 * error thrown from here has a fixed message built from the HTTP status or the finish
 * reason. Nothing from the upstream body is copied into a message. The body of a failed
 * request goes to `onFailure` only, for the server log (the caller redacts it).
 *
 * THINKING. The current models (`deepseek-flash`, `deepseek-v4-pro`) think by default, with
 * high effort. This client always sends `thinking`, so the mode never depends on a default
 * of the service. The thinking text (`delta.reasoning_content`) is not shown; it only keeps
 * the idle timer alive.
 *
 * TIME LIMITS. Three limits, not one: the first token (thinking or answer), the longest
 * silence between tokens, and the whole answer. DeepSeek holds a busy request open with
 * keep-alive comments; those do not count as tokens.
 */
import { ApiFailure } from '../provider/errors';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** `off`: no thinking, and `temperature` applies. The others are the DeepSeek effort levels. */
export const THINKING_LEVELS = ['off', 'low', 'high', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface StreamOptions {
  /** Overrides the client default for this call. */
  thinking?: ThinkingLevel;
}

export interface ChatClient {
  /** Yields the text deltas of the answer. Throws ApiFailure. */
  stream(messages: readonly ChatMessage[], signal: AbortSignal, options?: StreamOptions): AsyncIterable<string>;
}

export interface DeepSeekFailureInfo {
  /** The HTTP status, or 0 for a network failure, or 200 for a failure inside the stream. */
  status: number;
  /** The start of the upstream body, or the finish reason. For the log only: redact it. */
  detail: string;
  /** True when the client tries the request again. */
  retried: boolean;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: FetchLike;
  /** Default `off`. */
  thinking?: ThinkingLevel;
  /** Used only when thinking is off: DeepSeek ignores it in thinking mode. */
  temperature?: number;
  /** The first token (thinking or answer) must arrive in this time. */
  firstTokenTimeoutMs?: number;
  /** The longest silence between two tokens. */
  idleTimeoutMs?: number;
  /** The whole answer must arrive in this time. */
  timeoutMs?: number;
  /** Wait before the one retry of a 429, a 5xx, or a network failure. */
  retryDelayMs?: number;
  /** Called for each failed request, with data for the server log. */
  onFailure?: (info: DeepSeekFailureInfo) => void;
}

const MESSAGES = {
  unauthorized: 'The AI service refused the API key.',
  balance: 'The AI service account has no balance.',
  rateLimited: 'The AI service is busy. Try again in a minute.',
  timeout: 'The AI service did not answer in time.',
  upstream: 'The AI service failed.',
  rejected: 'The AI service rejected the request. Check the DEEPSEEK_MODEL setting.',
  cutLength: 'The answer reached the length limit. It is not complete.',
  cutFilter: 'The AI service stopped the answer. It is not complete.',
  cutStream: 'The connection to the AI service closed early. The answer is not complete.',
} as const;

const DEFAULTS = { firstTokenTimeoutMs: 90_000, idleTimeoutMs: 60_000, timeoutMs: 600_000, retryDelayMs: 1_000, temperature: 0.2 } as const;
const DETAIL_LENGTH = 300;

function failureFor(status: number): ApiFailure {
  if (status === 401 || status === 403) return new ApiFailure('UNAUTHORIZED', MESSAGES.unauthorized);
  if (status === 402) return new ApiFailure('UNAUTHORIZED', MESSAGES.balance);
  if (status === 429) return new ApiFailure('RATE_LIMITED', MESSAGES.rateLimited, 60);
  // A bad model name, a bad parameter: the same request cannot work.
  if (status === 400 || status === 404 || status === 422) return new ApiFailure('UPSTREAM_ERROR', MESSAGES.rejected);
  return new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
}

const canRetry = (status: number) => status === 0 || status === 429 || status >= 500;

/** Resolves after `ms`, or rejects when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
}

export class DeepSeekClient implements ChatClient {
  private readonly fetch: FetchLike;

  constructor(private readonly opts: DeepSeekOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The request body. Exported through the instance for the tests. */
  body(messages: readonly ChatMessage[], thinking: ThinkingLevel): Record<string, unknown> {
    const base = { model: this.opts.model, messages, stream: true };
    return thinking === 'off'
      ? { ...base, thinking: { type: 'disabled' }, temperature: this.opts.temperature ?? DEFAULTS.temperature }
      : { ...base, thinking: { type: 'enabled' }, reasoning_effort: thinking };
  }

  async *stream(messages: readonly ChatMessage[], signal: AbortSignal, options: StreamOptions = {}): AsyncIterable<string> {
    const o = this.opts;
    const body = JSON.stringify(this.body(messages, options.thinking ?? o.thinking ?? 'off'));
    const url = `${o.baseUrl.replace(/\/$/, '')}/chat/completions`;

    // One abort signal for the three time limits. `arm` starts the next limit.
    const limit = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      timedOut = true;
      limit.abort();
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
    };
    const total = setTimeout(expire, o.timeoutMs ?? DEFAULTS.timeoutMs);
    const both = AbortSignal.any([signal, limit.signal]);
    const broken = () => (timedOut ? new ApiFailure('UPSTREAM_TIMEOUT', MESSAGES.timeout) : new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream));
    const report = (status: number, detail: string, retried: boolean) => o.onFailure?.({ status, detail: detail.slice(0, DETAIL_LENGTH), retried });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      arm(o.firstTokenTimeoutMs ?? DEFAULTS.firstTokenTimeoutMs);

      // ── Open the stream. One retry for a failure that can pass: nothing is shown yet. ──
      let stream: ReadableStream<Uint8Array> | undefined;
      for (let attempt = 0; ; attempt++) {
        let status = 0;
        let detail = 'network failure';
        try {
          const r = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` }, body, signal: both });
          if (r.ok && r.body) {
            stream = r.body;
            break;
          }
          status = r.status;
          detail = await r.text().catch(() => '');
        } catch {
          if (signal.aborted || timedOut) throw broken();
        }
        const retry = attempt === 0 && canRetry(status);
        report(status, detail, retry);
        if (!retry) throw status === 0 ? broken() : failureFor(status);
        try {
          await sleep(o.retryDelayMs ?? DEFAULTS.retryDelayMs, both);
        } catch {
          throw broken();
        }
      }

      // ── Read the server-sent events. ──
      reader = stream.getReader();
      const decoder = new TextDecoder();
      const idleMs = o.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
      let buffer = '';
      let finish: string | null = null;
      // A read does not always end when the signal aborts (it depends on the fetch), so race it.
      const aborted = new Promise<never>((_, reject) => {
        if (both.aborted) reject(new Error('aborted'));
        else both.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      aborted.catch(() => undefined);
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([reader.read(), aborted]);
        } catch {
          throw broken();
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          // `data: {json}` lines; keep-alive comments start with ':'.
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            // `[DONE]` without a finish reason is a normal end (older responses).
            if (finish === null || finish === 'stop') return;
            throw this.cut(finish, report);
          }
          let parsed: StreamChunk;
          try {
            parsed = JSON.parse(data) as StreamChunk;
          } catch {
            report(200, 'a stream line is not JSON', false);
            throw new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finish = choice.finish_reason;
          const text = choice?.delta?.content;
          if (text || choice?.delta?.reasoning_content) arm(idleMs);
          if (text) yield text;
        }
      }
      // The body ended without `[DONE]`.
      if (finish === 'stop') return;
      throw this.cut(finish ?? 'closed', report);
    } finally {
      clearTimeout(timer);
      clearTimeout(total);
      // Cancel, not only release: a caller that stops early must close the upstream request.
      await reader?.cancel().catch(() => undefined);
    }
  }

  /** The failure for a stream that did not end with `stop`. */
  private cut(finish: string, report: (status: number, detail: string, retried: boolean) => void): ApiFailure {
    report(200, `finish_reason: ${finish}`, false);
    if (finish === 'length') return new ApiFailure('UPSTREAM_ERROR', MESSAGES.cutLength);
    if (finish === 'content_filter') return new ApiFailure('UPSTREAM_ERROR', MESSAGES.cutFilter);
    if (finish === 'insufficient_system_resource') return new ApiFailure('RATE_LIMITED', MESSAGES.rateLimited, 60);
    return new ApiFailure('UPSTREAM_ERROR', MESSAGES.cutStream);
  }
}
