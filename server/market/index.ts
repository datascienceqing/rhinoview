/**
 * Entry point of the synthetic market engine.
 *
 * Wire it with the factory, once, at server start:
 *
 *   import { createSyntheticEngine } from './market';
 *   const engine: MarketEngine = createSyntheticEngine({ delayed: env.SYNTHETIC_DELAYED });
 *
 * It is a factory rather than a singleton so tests can build engines with and without
 * the delayed flag and so nothing here reads the environment. Engines are cheap, hold
 * no external resources, and any two instances return identical data.
 *
 * The returned object also carries `listSymbols()` and `getSplits()` for tooling; the
 * HTTP layer should depend only on the `MarketEngine` interface.
 */
import { SyntheticMarketEngine } from './engine';
import type { SyntheticEngineOptions } from './engine';

export function createSyntheticEngine(options: SyntheticEngineOptions = {}): SyntheticMarketEngine {
  return new SyntheticMarketEngine(options);
}

export { SyntheticMarketEngine };
export type { SyntheticEngineOptions };
