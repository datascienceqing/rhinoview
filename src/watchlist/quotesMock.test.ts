/**
 * Guards mocks/quotes.ts against the contract. It lives here because only src/** runs
 * under the jsdom project that installs the MSW server.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { QuotesResponse } from '@shared/types';
import { MAX_QUOTE_SYMBOLS } from '@shared/types';
import { DataError, apiRequest } from '../data';
import { resetMockQuotes, setMockQuotesDelayed } from '../../mocks/quotes';

beforeEach(() => resetMockQuotes());

const get = (symbols: string) => apiRequest<QuotesResponse>('/quotes', { params: { symbols } });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof DataError ? e.code : 'thrown';
  }
};

describe('quotes mock', () => {
  it('returns quotes in request order with canonical symbols, de-duplicated case-insensitively', async () => {
    const r = await get('msft,AAPL,Msft,aapl,NVDA');
    expect(r.quotes.map((q) => q.symbol)).toEqual(['MSFT', 'AAPL', 'NVDA']);
    expect(r.missing).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it('gives every symbol different values', async () => {
    const r = await get('AAPL,MSFT,NVDA,AMZN,GOOGL');
    for (const field of ['price', 'changePercent', 'dayVolume'] as const) {
      expect(new Set(r.quotes.map((q) => q[field])).size).toBe(5);
    }
    expect(r.quotes.some((q) => (q.change ?? 0) > 0)).toBe(true);
    expect(r.quotes.some((q) => (q.change ?? 0) < 0)).toBe(true);
  });

  it('is deterministic per symbol', async () => {
    expect((await get('AAPL')).quotes).toEqual((await get('AAPL')).quotes);
  });

  it('treats changePercent as a fraction consistent with change and previousClose', async () => {
    const q = (await get('MSFT')).quotes[0];
    expect(q?.changePercent).toBeCloseTo((q?.change ?? 0) / (q?.previousClose ?? 1), 6);
  });

  it('puts unknown symbols in missing as spelled, and failed ones in failed, without failing the request', async () => {
    const r = await get('AAPL,zzbad,FAILME');
    expect(r.quotes.map((q) => q.symbol)).toEqual(['AAPL']);
    expect(r.missing).toEqual(['zzbad']);
    expect(r.failed).toEqual(['FAILME']);
  });

  it('succeeds with an empty quotes list when every symbol is unknown', async () => {
    const r = await get('ZZ1,ZZ2');
    expect(r).toEqual({ quotes: [], missing: ['ZZ1', 'ZZ2'], failed: [] });
  });

  it('fails the whole request only when every symbol failed', async () => {
    expect(await code(get('FAIL1,FAIL2'))).toBe('UPSTREAM_ERROR');
  });

  it('rejects an empty list, an empty entry, and an entry longer than 16 characters', async () => {
    expect(await code(get(''))).toBe('BAD_REQUEST');
    expect(await code(apiRequest('/quotes'))).toBe('BAD_REQUEST');
    expect(await code(get('AAPL,,MSFT'))).toBe('BAD_REQUEST');
    expect(await code(get('AAPL,'))).toBe('BAD_REQUEST');
    expect(await code(get('A'.repeat(17)))).toBe('BAD_REQUEST');
    expect(await code(get('A'.repeat(16)))).toBe('ok');
  });

  it('accepts 50 symbols and rejects 51', async () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`).join(',');
    expect((await get(list(MAX_QUOTE_SYMBOLS))).quotes).toHaveLength(MAX_QUOTE_SYMBOLS);
    expect(await code(get(list(MAX_QUOTE_SYMBOLS + 1)))).toBe('BAD_REQUEST');
  });

  it('marks quotes delayed on request', async () => {
    setMockQuotesDelayed(true);
    expect((await get('AAPL')).quotes[0]?.delayed).toBe(true);
  });
});
