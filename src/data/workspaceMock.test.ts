/**
 * Guards the frozen workspace mock (mocks/workspace.ts). W4 and W5 both build against
 * it, so it must refuse what the real server refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChartLayout, Watchlist, Workspace } from '@shared/types';
import { apiRequest } from './request';
import { DataError } from './errors';
import { resetMockWorkspace } from '../../mocks/workspace';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof DataError ? e.code : 'thrown';
  }
};

beforeEach(() => resetMockWorkspace());

describe('workspace mock', () => {
  it('starts with one layout and one watchlist, both active', async () => {
    const ws = await apiRequest<Workspace>('/workspace');
    expect(ws.layouts).toHaveLength(1);
    expect(ws.activeLayoutId).toBe(ws.layouts[0]?.id);
    expect(ws.activeWatchlistId).toBe(ws.watchlists[0]?.id);
  });

  it('rejects a stale revision with CONFLICT and increments revision on success', async () => {
    const [l] = (await apiRequest<Workspace>('/workspace')).layouts as [ChartLayout];
    const put = (revision: number) =>
      apiRequest<ChartLayout>(`/layouts/${l.id}`, { method: 'PUT', body: { revision, timeframe: '1W' } });
    expect((await put(1)).revision).toBe(2);
    expect(await code(put(1))).toBe('CONFLICT');
  });

  it('refuses to delete the last layout, and NOT_FOUND for an unknown id', async () => {
    const [l] = (await apiRequest<Workspace>('/workspace')).layouts as [ChartLayout];
    expect(await code(apiRequest(`/layouts/${l.id}`, { method: 'DELETE' }))).toBe('BAD_REQUEST');
    expect(await code(apiRequest('/layouts/nope', { method: 'DELETE' }))).toBe('NOT_FOUND');
  });

  it('rejects a duplicate name case-insensitively', async () => {
    expect(await code(apiRequest('/layouts', { method: 'POST', body: { name: '  main ' } }))).toBe('BAD_REQUEST');
  });

  it('moves the active layout to the newest remaining one when the active layout is deleted', async () => {
    const created = await apiRequest<ChartLayout>('/layouts', { method: 'POST', body: { name: 'Second' } });
    await apiRequest('/workspace/active', { method: 'PUT', body: { activeLayoutId: created.id } });
    const after = await apiRequest<Workspace>(`/layouts/${created.id}`, { method: 'DELETE' });
    expect(after.activeLayoutId).toBe(after.layouts[0]?.id);
  });

  it('uppercases and de-duplicates watchlist symbols, keeping order, and enforces the size cap', async () => {
    const w = await apiRequest<Watchlist>('/watchlists', { method: 'POST', body: { name: 'Tech', symbols: ['msft', 'AAPL', 'MSFT'] } });
    expect(w.symbols).toEqual(['MSFT', 'AAPL']);
    const tooMany = Array.from({ length: 51 }, (_, i) => `S${i}`);
    expect(await code(apiRequest('/watchlists', { method: 'POST', body: { name: 'Big', symbols: tooMany } }))).toBe('BAD_REQUEST');
  });
});
