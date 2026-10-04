/** Watchlist HTTP calls. Every request goes through `apiRequest`; components never call fetch. */
import type { EntityId, QuotesResponse, Watchlist, Workspace } from '@shared/types';
import { apiRequest } from '../data';

export interface WatchlistsState {
  watchlists: Watchlist[];
  activeWatchlistId: EntityId | null;
}

export const fetchWatchlists = (signal?: AbortSignal) =>
  apiRequest<WatchlistsState>('/watchlists', { signal });

export const createWatchlist = (name: string) =>
  apiRequest<Watchlist>('/watchlists', { method: 'POST', body: { name } });

export const updateWatchlist = (id: EntityId, body: { revision: number; name?: string; symbols?: string[] }) =>
  apiRequest<Watchlist>(`/watchlists/${encodeURIComponent(id)}`, { method: 'PUT', body });

export const deleteWatchlist = (id: EntityId) =>
  apiRequest<Workspace>(`/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Sends `activeWatchlistId` only: the layout's active id belongs to W4. */
export const setActiveWatchlist = (id: EntityId | null) =>
  apiRequest<Workspace>('/workspace/active', { method: 'PUT', body: { activeWatchlistId: id } });

export const fetchQuotes = (symbols: string[], signal?: AbortSignal) =>
  apiRequest<QuotesResponse>('/quotes', { params: { symbols: symbols.join(',') }, signal });
