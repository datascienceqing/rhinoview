/**
 * Thin HTTP client for Financial Modeling Prep's `/stable` API.
 *
 * KEY HANDLING. FMP authenticates with an `apikey` QUERY PARAMETER, so the key is part
 * of every request URL. Three rules keep it out of logs and responses:
 *   1. The full URL exists only as a local inside `getJson` and is handed to `fetch`.
 *      It is never logged, never put in an error, never returned.
 *   2. Every error thrown from here has a fixed message built from the endpoint PATH
 *      (no query string) and the HTTP status. Nothing from the upstream body is copied
 *      into a message, because FMP's 402 bodies are free text we do not control.
 *   3. `scrub()` strips the key (raw and URL-encoded) from anything that does get
 *      logged, as a backstop. `redact()` in `server/env.ts` only knows the massive key,
 *      so this module carries its own.
 *
 * ERRORS. 429 is retried with exponential backoff (FMP sends no rate-limit headers, so
 * the status alone is the signal; a `Retry-After`, if one ever appears, is honoured).
 * 402 is FMP's "not on your plan" and comes in two flavours that only the body text
 * tells apart: a restricted ENDPOINT, and a restricted SYMBOL, which is also what an
 * unknown symbol looks like on this tier (measured: `ZZZZNOPE` and `BRK-B` both 402).
 */
import { RateLimitedError, UpstreamTimeoutError, UpstreamUnauthorizedError } from '../../provider/errors';

export const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface FmpLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface FmpClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Injectable so backoff tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Retries after the first attempt, on 429 only. */
  maxRetries?: number;
  /** First backoff; doubles each retry. */
  backoffMs?: number;
  log?: FmpLogger;
}

/** A 402 from FMP. Maps to UNAUTHORIZED like any plan-tier failure; `scope` lets resolution treat a restricted symbol as unknown. */
export class FmpPaymentRequiredError extends UpstreamUnauthorizedError {
  constructor(public readonly scope: 'symbol' | 'endpoint') {
    super();
    this.name = 'FmpPaymentRequiredError';
  }
}

/** Anything else that is not a success: 5xx, unparseable body, network failure. Maps to UPSTREAM_ERROR. */
export class FmpUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FmpUpstreamError';
  }
}

const MAX_RETRY_AFTER_SECONDS = 30;
const noopLog: FmpLogger = { warn: () => undefined };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FmpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly log: FmpLogger;

  constructor(opts: FmpClientOptions) {
    if (!opts.apiKey) throw new Error('FMP API key is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? FMP_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.log = opts.log ?? noopLog;
  }

  /** Strip the key, raw and URL-encoded, from text bound for a log. */
  scrub(text: string): string {
    let out = text.split(this.apiKey).join('[REDACTED]');
    const encoded = encodeURIComponent(this.apiKey);
    if (encoded !== this.apiKey) out = out.split(encoded).join('[REDACTED]');
    return out;
  }

  /** GET `path` (e.g. `/quote`) with `params`; resolves to the parsed JSON body. */
  async getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) query.set(k, String(v));
    query.set('apikey', this.apiKey);
    const url = `${this.baseUrl}${path}?${query.toString()}`;

    let delayMs = this.backoffMs;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new UpstreamTimeoutError();
        }
        // The cause can embed the whole URL, key included (undici does). Log it with any URL
        // cut out and the key scrubbed as a backstop; never rethrow it.
        const cause = (err instanceof Error ? err.message : String(err)).replace(/https?:\/\/\S+/g, '<url>');
        this.log.warn({ path, cause: this.scrub(cause) }, 'fmp request failed');
        throw new FmpUpstreamError(`FMP request to ${path} failed`);
      }

      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : delayMs;
        if (attempt >= this.maxRetries) throw new RateLimitedError(Math.max(1, Math.ceil(waitMs / 1000)));
        this.log.warn({ path, attempt: attempt + 1, waitMs }, 'fmp rate limited, backing off');
        await this.sleep(waitMs);
        delayMs *= 2;
        continue;
      }

      if (res.status === 401 || res.status === 403) throw new UpstreamUnauthorizedError();
      if (res.status === 402) {
        const body = await res.text().catch(() => '');
        // Measured bodies: "Premium Query Parameter: ... 'symbol' is not available ..." vs
        // "Restricted Endpoint: This endpoint is not available ...".
        throw new FmpPaymentRequiredError(/query parameter/i.test(body) && /symbol/i.test(body) ? 'symbol' : 'endpoint');
      }
      if (!res.ok) {
        this.log.warn({ path, status: res.status }, 'fmp upstream error');
        throw new FmpUpstreamError(`FMP ${path} returned HTTP ${res.status}`);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new FmpUpstreamError(`FMP ${path} returned an unparseable body`);
      }
      // FMP reports some failures as a 200 with {"Error Message": "..."}; the text is not ours to forward.
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'Error Message' in body) {
        throw new FmpUpstreamError(`FMP ${path} reported an error`);
      }
      return body;
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
