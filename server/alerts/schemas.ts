/**
 * zod schemas for alerts: HTTP bodies (strict, so unknown fields are rejected) and the
 * on-disk file (docs/ALERTS_PLAN.md, section 5.3).
 *
 * The shapes live here; the semantic rules (indicator params, line keys, finite numbers,
 * message length) live in `src/alerts/condition.ts`, so the dialog, the store and the
 * mock use one function.
 */
import { z } from 'zod';
import { ALERT_EXPIRY_CHOICES, ALERT_INDICATOR_KINDS, TIMEFRAMES } from '@shared/types';
import type { AlertCondition, IndicatorParams, SetCheckedBody, Timeframe } from '@shared/types';

const timeframe = z.enum(TIMEFRAMES as readonly [string, ...string[]]) as unknown as z.ZodType<Timeframe>;
const direction = z.enum(['cross', 'up', 'down']);
const finite = z.number().finite();

const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('value'), value: finite }).strict(),
  z.object({ type: z.literal('close') }).strict(),
  z.object({ type: z.literal('line'), line: z.string().min(1) }).strict(),
]);

export const alertConditionSchema: z.ZodType<AlertCondition> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price'), direction, level: finite }).strict(),
  z
    .object({
      type: z.literal('indicator'),
      timeframe,
      indicator: z
        .object({
          kind: z.enum(ALERT_INDICATOR_KINDS),
          params: z.custom<IndicatorParams>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), {
            message: 'params must be an object',
          }),
        })
        .strict(),
      line: z.string().min(1),
      direction,
      target,
    })
    .strict(),
]) as z.ZodType<AlertCondition>;

const expiry = z.enum(ALERT_EXPIRY_CHOICES);
const frequency = z.enum(['once', 'every']);
const revision = z.number().int().min(1);
const id = z.string().min(1);
const seconds = z.number().int();

export const createAlertBodySchema = z
  .object({
    symbol: z.string(),
    condition: alertConditionSchema,
    frequency: frequency.optional(),
    expiry: expiry.optional(),
    message: z.string().optional(),
  })
  .strict();

export const updateAlertBodySchema = z
  .object({
    revision,
    condition: alertConditionSchema.optional(),
    frequency: frequency.optional(),
    expiry: expiry.optional(),
    message: z.string().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();

export const setCheckedBodySchema: z.ZodType<SetCheckedBody> = z.union([
  z.object({ ids: z.array(id).min(1).max(1000) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

const checkState = z
  .object({
    lastSide: z.enum(['above', 'below']).nullable(),
    lastCheckedAt: seconds.nullable(),
    lastBarTime: seconds.nullable(),
    firedCount: z.number().int().min(0),
    lastFiredAt: seconds.nullable(),
  })
  .strict();

export const alertSchema = z
  .object({
    id,
    symbol: z.string(),
    condition: alertConditionSchema,
    frequency,
    expiry,
    expiresAt: seconds,
    message: z.string(),
    status: z.enum(['active', 'paused', 'triggered', 'expired']),
    revision,
    createdAt: seconds,
    updatedAt: seconds,
    state: checkState,
  })
  .strict();

export const alertEventSchema = z
  .object({
    id,
    alertId: id,
    symbol: z.string(),
    condition: alertConditionSchema,
    message: z.string(),
    firedAt: seconds,
    crossed: z.enum(['up', 'down']),
    value: finite,
    target: finite,
    delayed: z.boolean(),
    checked: z.boolean(),
  })
  .strict();

export const ALERTS_FILE_VERSION = 1;

/**
 * The file as stored (`ALERTS_FILE`). Alerts and events are checked one by one in the
 * store, which drops an invalid entry instead of the whole file, like the workspace does.
 */
export const alertsFileSchema = z
  .object({
    version: z.literal(ALERTS_FILE_VERSION),
    alerts: z.array(z.unknown()),
    events: z.array(z.unknown()),
  })
  .strict();
