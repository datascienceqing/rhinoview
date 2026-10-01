import type {
  ApiErrorCode,
  ApiResult,
  BarsQuery,
  BarsResponse,
  SearchResponse,
  Snapshot,
} from '@shared/types';
import type { DataSource, RequestOptions, SearchOptions } from './DataSource';
import { API_ERROR_CODES, DataError } from './errors';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpDataSourceOptions {
  /** Defaults to same-origin `/api`. */
  baseUrl?: string;
  /** Injectable for tests. Resolved lazily so a later-patched global fetch (MSW) is honoured. */
  fetch?: FetchLike;
}

export class HttpDataSource implements DataSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(options: HttpDataSourceOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api';
    this.fetchImpl = options.fetch;
  }

  searchSymbols(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const params: Record<string, string> = { q: query };
    if (options.limit !== undefined) params.limit = String(options.limit);
    return this.get<SearchResponse>('/search', params, options);
  }

  getBars(query: BarsQuery, options: RequestOptions = {}): Promise<BarsResponse> {
    const params: Record<string, string> = {
      symbol: query.symbol,
      timeframe: query.timeframe,
      from: String(query.from),
      to: String(query.to),
    };
    if (query.adjusted !== undefined) params.adjusted = String(query.adjusted);
    return this.get<BarsResponse>('/bars', params, options);
  }

  getSnapshot(symbol: string, options: RequestOptions = {}): Promise<Snapshot> {
    return this.get<Snapshot>('/snapshot', { symbol }, options);
  }

  private url(path: string, params: Record<string, string>): string {
    // Resolved against the page origin when there is one: browsers accept relative
    // URLs in fetch, but Node's fetch (used under test) does not.
    const origin = typeof location === 'undefined' ? 'http://localhost' : location.href;
    const url = new URL(`${this.baseUrl}${path}`, origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async get<T>(path: string, params: Record<string, string>, options: RequestOptions): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) throw abortedError();

    let response: Response;
    try {
      const doFetch: FetchLike = this.fetchImpl ?? ((input, init) => fetch(input, init));
      response = await doFetch(this.url(path, params), { signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (signal?.aborted || isAbortLike(e)) throw abortedError(e);
      throw new DataError('NETWORK', 'Network request failed', { cause: e });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (e) {
      if (signal?.aborted || isAbortLike(e)) throw abortedError(e);
      throw errorForUnparseable(response);
    }

    if (!isEnvelope(body)) throw errorForUnparseable(response);
    return unwrap(body as ApiResult<T>, response.status);
  }
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
