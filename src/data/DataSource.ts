import type { BarsQuery, BarsResponse, SearchResponse, Snapshot } from '@shared/types';

export interface RequestOptions {
  /**
   * Cancels the request. Implementations must reject with
   * `DataError('ABORTED')` when this fires.
   */
  signal?: AbortSignal;
}

export interface SearchOptions extends RequestOptions {
  /** 1-50; the proxy defaults to 10. */
  limit?: number;
}

/**
 * The only way components reach market data. An HTTP implementation exists today;
 * a WebSocket one lands behind this same interface later. Nothing above this line
 * may know about fetch, URLs, or status codes.
 *
 * Every method resolves with unwrapped data or rejects with a `DataError`.
 */
export interface DataSource {
  searchSymbols(query: string, options?: SearchOptions): Promise<SearchResponse>;
  getBars(query: BarsQuery, options?: RequestOptions): Promise<BarsResponse>;
  getSnapshot(symbol: string, options?: RequestOptions): Promise<Snapshot>;
}
