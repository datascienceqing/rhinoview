/**
 * Entry point of the FMP provider. The API key is passed in by the caller (which reads
 * it from `server/env.ts`); this module never touches `process.env`.
 */
import { FmpEngine } from './engine';
import type { FmpEngineOptions } from './engine';

export function createFmpEngine(options: FmpEngineOptions): FmpEngine {
  return new FmpEngine(options);
}

export { FmpEngine };
export type { AsyncMarketEngine, FmpEngineOptions } from './engine';
