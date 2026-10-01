/**
 * Environment loading and validation.
 *
 * ORCHESTRATOR-OWNED — do not edit. This is the only place the API key is read.
 * The key must never be logged, echoed in an error message, returned in a
 * response body, or interpolated into a URL that could end up in a log line.
 */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MASSIVE_API_KEY: z.string().min(1, 'MASSIVE_API_KEY is required — copy .env.example to .env'),
  SERVER_PORT: z.coerce.number().int().positive().default(8787),
  MASSIVE_BASE_URL: z.string().url().default('https://api.massive.com'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Print field names and messages only. Never print values — one of them is the key.
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = parsed.data;

/** Redact the key from any string before it reaches a log or an error message. */
export function redact(text: string): string {
  return text.split(env.MASSIVE_API_KEY).join('[REDACTED]');
}
