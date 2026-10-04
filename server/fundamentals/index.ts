/**
 * Fundamentals provider factory. PHASE 5 STUB — Worker W2 replaces the body.
 *
 * Selects a FundamentalsProvider from DATA_PROVIDER: `synthetic` gets the synthetic
 * provider, `fmp` gets the FMP provider. Until W2 lands, every provider is unavailable.
 */
import { UnknownSymbolError } from '../market/types';
import type { FundamentalsProvider } from './types';

export type { FundamentalsProvider } from './types';

/** A provider that serves nothing. `/api/capabilities` then reports `fundamentals: false`. */
export const UNAVAILABLE_FUNDAMENTALS: FundamentalsProvider = {
  available: false,
  getOverview: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
  getStatements: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
  getEarnings: (symbol) => Promise.reject(new UnknownSymbolError(symbol)),
};

export async function createFundamentalsProvider(): Promise<FundamentalsProvider> {
  return UNAVAILABLE_FUNDAMENTALS;
}
