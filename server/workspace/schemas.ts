/**
 * zod schemas for the workspace: HTTP bodies (strict, so unknown fields are rejected)
 * and the on-disk file. Semantic rules (names, limits, symbol canonicalization,
 * indicator bounds) live in `store.ts`, so the store is safe to call without HTTP.
 */
import { z } from 'zod';
import { TIMEFRAMES } from '@shared/types';
import type { IndicatorKind, IndicatorParams } from '@shared/types';

const CHART_TYPES = ['candlestick', 'line', 'bar'] as const;
const KINDS = ['sma', 'ema', 'rsi', 'macd', 'volume', 'vpvr', 'liquidity', 'confluence', 'fvg', 'cvwap'] as const satisfies readonly IndicatorKind[];

const timeframe = z.enum(TIMEFRAMES as readonly [string, ...string[]]) as unknown as z.ZodType<
  (typeof TIMEFRAMES)[number]
>;
const chartType = z.enum(CHART_TYPES);
/**
 * The file can hold 'area', a chart type that 'bar' replaced. Read it as 'bar', so that an
 * old file keeps its layouts instead of being renamed as corrupt (invariant 4).
 */
const storedChartType = z.enum([...CHART_TYPES, 'area']).transform((t) => (t === 'area' ? 'bar' : t));

/**
 * `params` keys are not restricted here on purpose: the bounds and the allowed shapes
 * belong to `checkIndicatorParams`, the same function the client editor uses.
 */
export const indicatorConfigSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS),
    params: z.custom<IndicatorParams>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), {
      message: 'params must be an object',
    }),
    color: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();

const revision = z.number().int().min(1);

export const createLayoutBodySchema = z
  .object({
    name: z.string(),
    symbol: z.string().optional(),
    timeframe: timeframe.optional(),
    chartType: chartType.optional(),
    indicators: z.array(indicatorConfigSchema).optional(),
  })
  .strict();

export const updateLayoutBodySchema = z
  .object({
    revision,
    name: z.string().optional(),
    symbol: z.string().optional(),
    timeframe: timeframe.optional(),
    chartType: chartType.optional(),
    indicators: z.array(indicatorConfigSchema).optional(),
  })
  .strict();

export const createWatchlistBodySchema = z
  .object({ name: z.string(), symbols: z.array(z.string()).optional() })
  .strict();

export const updateWatchlistBodySchema = z
  .object({ revision, name: z.string().optional(), symbols: z.array(z.string()).optional() })
  .strict();

export const setActiveBodySchema = z
  .object({ activeLayoutId: z.string().optional(), activeWatchlistId: z.string().nullable().optional() })
  .strict();

const entityBase = {
  id: z.string().min(1),
  name: z.string(),
  revision,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
};

export const FILE_VERSION = 1;

/**
 * The file as stored. Strict: a field we did not write means the file is not ours.
 *
 * Indicators are the exception: they are checked one by one in `store.ts`, which drops
 * an invalid one instead of rejecting the whole file. A file written by a newer branch
 * can hold an indicator kind this code does not know, and that must not cost the user
 * every layout and watchlist (invariant 4).
 */
export const workspaceFileSchema = z
  .object({
    version: z.literal(FILE_VERSION),
    layouts: z
      .array(
        z
          .object({
            ...entityBase,
            symbol: z.string(),
            timeframe,
            chartType: storedChartType,
            indicators: z.array(z.unknown()),
          })
          .strict(),
      )
      .min(1),
    watchlists: z.array(z.object({ ...entityBase, symbols: z.array(z.string()) }).strict()),
    activeLayoutId: z.string(),
    activeWatchlistId: z.string().nullable(),
  })
  .strict();
