/**
 * Fundamentals provider factory.
 *
 * Selects a FundamentalsProvider from DATA_PROVIDER: `synthetic` gets the synthetic
 * provider, `fmp` gets the FMP provider behind the 6 h / 1 h cache. `massive` has no
 * fundamentals, so it gets the unavailable provider and `/api/capabilities` reports
 * `fundamentals: false`.
 */
import { env } from '../env';
import { FmpClient } from '../market/fmp/client';
import { UnknownSymbolError } from '../market/types';
import { CachedFundamentalsProvider } from './cache';
import { FmpFundamentalsProvider } from './fmp/provider';
import { SyntheticFundamentalsProvider } from './synthetic/provider';
import type { FundamentalsProvider } from './types';

export type { FundamentalsProvider } from './types';

/** A provider that serves nothing. `/api/capabilities` then reports `fundamentals: false`. */
export const UNAVAILABLE_FUNDAMENTALS: FundamentalsProvider = {
  available: false,
  getOverview: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
  getStatements: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
  getEarnings: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
  getNews: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
};

export interface CreateFundamentalsOptions {
  provider?: 'synthetic' | 'massive' | 'fmp';
  /** Required for `fmp`. The caller reads it from `server/env.ts`; this module never touches `process.env`. */
  apiKey?: string | undefined;
}

export async function createFundamentalsProvider(opts: CreateFundamentalsOptions = {}): Promise<FundamentalsProvider> {
  const which = opts.provider ?? env.DATA_PROVIDER;
  switch (which) {
    case 'synthetic':
      return new SyntheticFundamentalsProvider();
    case 'fmp': {
      const apiKey = 'apiKey' in opts ? opts.apiKey : env.FMP_API_KEY;
      if (!apiKey) throw new Error('FMP_API_KEY is required when DATA_PROVIDER=fmp');
      return new CachedFundamentalsProvider(new FmpFundamentalsProvider({ source: new FmpClient({ apiKey }) }));
    }
    case 'massive':
      return UNAVAILABLE_FUNDAMENTALS;
  }
}
