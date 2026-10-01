/**
 * Engine selection. The only place `DATA_PROVIDER` is branched on.
 *
 * Async because the synthetic engine is loaded with a dynamic import: nothing that
 * merely builds a server around an injected engine (every test in this layer) pays
 * for, or depends on, the real engine's module graph.
 */
import type { MarketEngine } from '../market/types';
import { env } from '../env';

export async function selectEngine(provider: 'synthetic' | 'massive' = env.DATA_PROVIDER): Promise<MarketEngine> {
  switch (provider) {
    case 'synthetic': {
      const { createSyntheticEngine } = await import('../market');
      return createSyntheticEngine({ delayed: env.SYNTHETIC_DELAYED });
    }
    case 'massive':
      // Deliberately not a stub and not a fallback to synthetic: silently serving
      // fake prices under a real-data configuration would look exactly like success.
      throw new Error(
        'DATA_PROVIDER=massive is not implemented yet. Unset DATA_PROVIDER (or set it to "synthetic") to run on the synthetic engine.',
      );
  }
}
