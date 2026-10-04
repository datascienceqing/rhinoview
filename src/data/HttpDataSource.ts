import type { BarsQuery, BarsResponse, SearchResponse, Snapshot } from '@shared/types';
import type { DataSource, RequestOptions, SearchOptions } from './DataSource';
import { apiRequest } from './request';
import type { FetchLike } from './request';

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

  private get<T>(path: string, params: Record<string, string>, options: RequestOptions): Promise<T> {
    return apiRequest<T>(path, { params, signal: options.signal, baseUrl: this.baseUrl, fetch: this.fetchImpl });
  }
}
