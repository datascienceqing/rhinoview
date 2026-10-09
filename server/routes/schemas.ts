/**
 * zod schemas for every inbound query string, plus the parse helper that turns a
 * failure into a `BAD_REQUEST` naming the offending parameter.
 */
import { z } from 'zod';
import { TIMEFRAMES } from '@shared/types';
import type { IndicatorKind, Timeframe } from '@shared/types';
import { ApiFailure } from '../provider/errors';

/** 2100-01-01 UTC. Anything larger is almost certainly milliseconds (the blank-chart bug). */
const MAX_UNIX_SECONDS = 4_102_444_800;
const MAX_PERIOD = 500;

const INDICATOR_KINDS = ['sma', 'ema', 'rsi', 'macd', 'volume'] as const satisfies readonly IndicatorKind[];

// Query values are strings (or string[] when repeated). Parse integers strictly:
// `z.coerce.number()` would accept "" as 0 and "1e3" as 1000.
const intString = z.string().regex(/^-?\d+$/, 'must be an integer').transform(Number);

const symbol = z.string().min(1).max(16);
const timeframe = z.enum(TIMEFRAMES as readonly [Timeframe, ...Timeframe[]], {
  errorMap: () => ({ message: `must be one of ${TIMEFRAMES.join(', ')}` }),
});
const unixSeconds = intString.pipe(
  z
    .number()
    .int()
    .min(0, 'must be Unix seconds, not negative')
    .max(MAX_UNIX_SECONDS, 'must be Unix seconds (this looks like milliseconds)'),
);
// `from` below the epoch is a well-formed request meaning "from the beginning", and a
// client should not have to know the proxy's epoch bounds to ask for it, so it is
// clamped to 0 rather than rejected. (`to` is not: a range ending before 0 is empty
// by construction and must still satisfy to >= from.) Malformed input, and values
// that look like milliseconds, are still rejected.
const fromSeconds = intString.pipe(
  z
    .number()
    .int()
    .max(MAX_UNIX_SECONDS, 'must be Unix seconds (this looks like milliseconds)')
    .transform((v) => Math.max(0, v)),
);
const period = intString.pipe(z.number().int().min(1).max(MAX_PERIOD));

const bool = z
  .enum(['true', 'false'], { errorMap: () => ({ message: 'must be "true" or "false"' }) })
  .transform((v) => v === 'true');

const rangeCheck = (v: { from: number; to: number }, ctx: z.RefinementCtx) => {
  if (v.to < v.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be >= from' });
};

export const searchQuery = z.object({
  q: z.string().trim().min(1, 'must not be empty').max(32),
  limit: intString.pipe(z.number().int().min(1).max(50)).default('10'),
});

export const barsQuery = z
  .object({
    symbol,
    timeframe,
    from: fromSeconds,
    to: unixSeconds,
    adjusted: bool.default('true'),
  })
  .superRefine(rangeCheck);

export const snapshotQuery = z.object({ symbol });

export const indicatorQuery = z
  .object({
    symbol,
    timeframe,
    kind: z.enum(INDICATOR_KINDS, {
      errorMap: () => ({ message: `must be one of ${INDICATOR_KINDS.join(', ')}` }),
    }),
    from: fromSeconds,
    to: unixSeconds,
    period: period.optional(),
    fastPeriod: period.optional(),
    slowPeriod: period.optional(),
    signalPeriod: period.optional(),
  })
  .superRefine(rangeCheck)
  .transform((v, ctx) => {
    const missing = (name: string): typeof z.NEVER => {
      ctx.addIssue({ code: 'custom', path: [name], message: `is required for kind=${v.kind}` });
      return z.NEVER;
    };
    const base = { symbol: v.symbol, timeframe: v.timeframe, from: v.from, to: v.to };
    if (v.kind === 'macd') {
      const { fastPeriod, slowPeriod, signalPeriod } = v;
      if (fastPeriod === undefined) return missing('fastPeriod');
      if (slowPeriod === undefined) return missing('slowPeriod');
      if (signalPeriod === undefined) return missing('signalPeriod');
      if (fastPeriod >= slowPeriod) {
        ctx.addIssue({ code: 'custom', path: ['fastPeriod'], message: 'must be < slowPeriod' });
        return z.NEVER;
      }
      return { ...base, spec: { kind: 'macd' as const, fastPeriod, slowPeriod, signalPeriod } };
    }
    if (v.period === undefined) return missing('period');
    return { ...base, spec: { kind: v.kind, period: v.period } };
  });

/** Parse `input` or throw `BAD_REQUEST` whose message names the first offending parameter. */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  const issue = result.error.issues[0];
  const param = issue?.path.join('.') || 'query';
  // zod says "Required" for a missing key; make that say what is missing.
  const detail = issue?.message === 'Required' ? 'is required' : (issue?.message ?? 'is invalid');
  throw new ApiFailure('BAD_REQUEST', `Invalid query parameter "${param}": ${detail}`);
}
