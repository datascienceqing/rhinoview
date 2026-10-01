/**
 * Fault injection for the synthetic provider. Exists so the client's loading,
 * rate-limit, and error states are reachable in development instead of theoretical.
 * Never constructed for a real provider (see `faultsFromEnv`).
 */
import { env } from '../env';
import { RateLimitedError } from './errors';

export interface FaultConfig {
  latencyMs: number;
  /** Fraction of requests answered RATE_LIMITED, 0..1. */
  rateLimitRate: number;
  /** Fraction of requests answered UPSTREAM_ERROR, 0..1. */
  errorRate: number;
  /** Retry-After to advertise on an injected rate limit. */
  retryAfterSeconds: number;
}

export const NO_FAULTS: FaultConfig = { latencyMs: 0, rateLimitRate: 0, errorRate: 0, retryAfterSeconds: 5 };

export function faultsFromEnv(): FaultConfig {
  if (env.DATA_PROVIDER !== 'synthetic') return NO_FAULTS;
  return {
    ...NO_FAULTS,
    latencyMs: env.SYNTHETIC_LATENCY_MS,
    rateLimitRate: env.SYNTHETIC_RATE_LIMIT_RATE,
    errorRate: env.SYNTHETIC_ERROR_RATE,
  };
}

export class InjectedFaultError extends Error {
  constructor() {
    super('Injected synthetic upstream failure');
    this.name = 'InjectedFaultError';
  }
}

export interface FaultInjector {
  /** Delay, then maybe throw. Awaited before every upstream-bound engine call. */
  gate(): Promise<void>;
}

/**
 * One uniform draw decides the outcome so the configured rates are the true
 * fractions: u < rateLimitRate → 429, next errorRate slice → 502, else pass.
 * `random` and `sleep` are injectable so tests are deterministic and instant.
 */
export function createFaultInjector(
  config: FaultConfig,
  random: () => number = Math.random,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): FaultInjector {
  const active = config.latencyMs > 0 || config.rateLimitRate > 0 || config.errorRate > 0;
  return {
    async gate() {
      if (!active) return;
      if (config.latencyMs > 0) await sleep(config.latencyMs);
      const u = random();
      if (u < config.rateLimitRate) throw new RateLimitedError(config.retryAfterSeconds);
      if (u < config.rateLimitRate + config.errorRate) throw new InjectedFaultError();
    },
  };
}
