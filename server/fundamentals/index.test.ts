/** Provider selection from DATA_PROVIDER. */
import { describe, expect, it } from 'vitest';
import { UnknownSymbolError } from '../market/types';
import { CachedFundamentalsProvider } from './cache';
import { SyntheticFundamentalsProvider } from './synthetic/provider';
import { UNAVAILABLE_FUNDAMENTALS, createFundamentalsProvider } from './index';

describe('createFundamentalsProvider', () => {
  it('gives the synthetic provider for DATA_PROVIDER=synthetic', async () => {
    const p = await createFundamentalsProvider({ provider: 'synthetic' });
    expect(p).toBeInstanceOf(SyntheticFundamentalsProvider);
    expect(p.available).toBe(true);
  });

  it('gives the FMP provider behind the cache for DATA_PROVIDER=fmp, without any network call', async () => {
    const p = await createFundamentalsProvider({ provider: 'fmp', apiKey: 'k' });
    expect(p).toBeInstanceOf(CachedFundamentalsProvider);
    expect(p.available).toBe(true);
  });

  it('refuses fmp without a key, at boot', async () => {
    await expect(createFundamentalsProvider({ provider: 'fmp', apiKey: undefined })).rejects.toThrow('FMP_API_KEY is required');
  });

  it('serves no fundamentals for massive', async () => {
    expect(await createFundamentalsProvider({ provider: 'massive' })).toBe(UNAVAILABLE_FUNDAMENTALS);
    expect(UNAVAILABLE_FUNDAMENTALS.available).toBe(false);
    await expect(UNAVAILABLE_FUNDAMENTALS.getOverview('AAPL')).rejects.toBeInstanceOf(UnknownSymbolError);
  });

  it('defaults to the synthetic provider when the environment names none', async () => {
    expect((await createFundamentalsProvider()).available).toBe(true);
  });
});
