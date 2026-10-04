/**
 * The ONE place the client talks HTTP to the proxy.
 *
 * Every client module — `HttpDataSource`, and the Phase 5 watchlist, workspace and
 * fundamentals API modules — goes through `apiRequest`. Components never call `fetch`.
 * Centralising it means the envelope handling, abort semantics and error mapping
 * below exist exactly once, so a fix here is a fix everywhere.
 */
import type { ApiErrorCode, ApiResult } from '@shared/types';
import { API_ERROR_CODES, DataError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query-string parameters. */
  params?: Record<string, string>;
  /** JSON request body (POST/PUT). */
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Defaults to same-origin `/api`. */
  baseUrl?: string;
  /** Injectable for tests. Resolved lazily so a later-patched global fetch (MSW) is honoured. */
  fetch?: FetchLike | undefined;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', params, body, signal, baseUrl = '/api' } = options;
  if (signal?.aborted) throw abortedError();

  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, signal: signal ?? null, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    const doFetch: FetchLike = options.fetch ?? ((input, i) => fetch(input, i));
    response = await doFetch(buildUrl(baseUrl, path, params ?? {}), init);
  } catch (e) {
    if (signal?.aborted || isAbortLike(e)) throw abortedError(e);
    throw new DataError('NETWORK', 'Network request failed', { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    if (signal?.aborted || isAbortLike(e)) throw abortedError(e);
    throw errorForUnparseable(response);
  }

  if (!isEnvelope(parsed)) throw errorForUnparseable(response);
  return unwrap(parsed as ApiResult<T>, response.status);
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  // Resolved against the page origin when there is one: browsers accept relative
  // URLs in fetch, but Node's fetch (used under test) does not.
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.href;
  const url = new URL(`${baseUrl}${path}`, origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function unwrap<T>(result: ApiResult<T>, status: number): T {
  if (result.ok) return result.data;
  const { error } = result;
  // A server speaking the contract but with a code we do not know is a server bug,
  // not something the UI can branch on. INTERNAL is the contract's catch-all.
  const code: ApiErrorCode = API_ERROR_CODES.includes(error.code) ? error.code : 'INTERNAL';
  throw DataError.fromApiError({ ...error, code }, status);
}

function isEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.ok === true) return 'data' in b;
  if (b.ok === false) {
    const err = b.error as Record<string, unknown> | undefined;
    return typeof err === 'object' && err !== null && typeof err.code === 'string';
  }
  return false;
}

/**
 * A response with no usable envelope. Map by HTTP status where that is unambiguous
 * (a dev-server proxy answering 502/504 with an HTML page when the backend is down),
 * otherwise BAD_RESPONSE. 404 is deliberately NOT UNKNOWN_SYMBOL here: only an
 * envelope can say the symbol was missing; a bare 404 is a missing route.
 */
function errorForUnparseable(response: Response): DataError {
  const { status } = response;
  if (status === 429) {
    const header = Number(response.headers.get('Retry-After'));
    return new DataError('RATE_LIMITED', 'Rate limited', {
      status,
      retryAfterSeconds: Number.isFinite(header) && header > 0 ? header : undefined,
    });
  }
  if (status === 504) return new DataError('UPSTREAM_TIMEOUT', 'Gateway timeout', { status });
  if (status >= 500) return new DataError('UPSTREAM_ERROR', `Server error (${status})`, { status });
  return new DataError('BAD_RESPONSE', `Unreadable response (${status})`, { status });
}

function isAbortLike(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function abortedError(cause?: unknown): DataError {
  return new DataError('ABORTED', 'Request aborted', { cause });
}
