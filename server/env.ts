/**
 * Environment loading and validation.
 *
 * ORCHESTRATOR-OWNED — do not edit.
 *
 * `DATA_PROVIDER` selects where market data comes from. `synthetic` is the default
 * and needs no credentials; `massive` requires a key and is not implemented yet.
 * This is the only place the API key is read. It must never be logged, echoed in an
 * error message, returned in a response body, or interpolated into a URL that could
 * reach a log line.
 */
import 'dotenv/config';
import { z } from 'zod';

/**
 * Treat an empty env var as absent. `.env` files conventionally carry placeholder
 * keys like `MASSIVE_API_KEY=`, and an empty string must not read as "provided".
 */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner);

const schema = z
  .object({
    DATA_PROVIDER: z.enum(['synthetic', 'massive', 'fmp']).default('synthetic'),

    /** Required only when DATA_PROVIDER=fmp. */
    FMP_API_KEY: optional(z.string().min(1).optional()),

    /** Required only when DATA_PROVIDER=massive. */
    MASSIVE_API_KEY: optional(z.string().min(1).optional()),
    MASSIVE_BASE_URL: optional(z.string().url().default('https://api.massive.com')),

    SERVER_PORT: z.coerce.number().int().positive().default(8787),

    /** Where the workspace (named layouts and watchlists) is saved. Gitignored. */
    WORKSPACE_FILE: optional(z.string().min(1).default('data/workspace.json')),

    /** Where the alerts and the alert event log are saved. Gitignored. */
    ALERTS_FILE: optional(z.string().min(1).default('data/alerts.json')),
    /** Upstream calls a minute for the alert checker (not used with the synthetic provider). */
    ALERT_CALL_BUDGET: z.coerce.number().int().min(1).max(1_000).default(150),

    /**
     * Synthetic-provider fault injection, so the client's error and loading states
     * are reachable in development rather than theoretical. All default to off.
     */
    SYNTHETIC_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(0),
    /** Fraction of requests answered with RATE_LIMITED, 0..1. */
    SYNTHETIC_RATE_LIMIT_RATE: z.coerce.number().min(0).max(1).default(0),
    /** Fraction of requests answered with UPSTREAM_ERROR, 0..1. */
    SYNTHETIC_ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
    /** Report synthetic data as delayed, exercising the UI's delayed badge. */
    SYNTHETIC_DELAYED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((v) => v.DATA_PROVIDER !== 'massive' || Boolean(v.MASSIVE_API_KEY), {
    message: 'MASSIVE_API_KEY is required when DATA_PROVIDER=massive',
    path: ['MASSIVE_API_KEY'],
  })
  .refine((v) => v.DATA_PROVIDER !== 'fmp' || Boolean(v.FMP_API_KEY), {
    message: 'FMP_API_KEY is required when DATA_PROVIDER=fmp',
    path: ['FMP_API_KEY'],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Print field names and messages only. Never print values — one of them is the key.
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  const message = `Invalid environment:\n${issues}`;

  // A misconfiguration is operator error, not a crash: print the fix and exit. The
  // throw would otherwise surface as a stack trace through this module's import,
  // which no caller can catch — ESM imports are hoisted above any try/catch.
  // Under vitest we throw instead, so the validation stays assertable.
  if (process.env.VITEST) {
    throw new Error(message);
  }
  process.stderr.write(`\n${message}\n\nSee .env.example for the expected values.\n\n`);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Redact the API key from any string before it reaches a log or an error message.
 * A no-op when no key is configured, which is the normal synthetic-provider case.
 */
export function redact(text: string): string {
  let out = text;
  for (const key of [env.MASSIVE_API_KEY, env.FMP_API_KEY]) {
    if (key) out = out.split(key).join('[REDACTED]');
  }
  return out;
}
