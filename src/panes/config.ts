import type {
  IndicatorConfig,
  IndicatorKind,
  IndicatorParams,
  MacdParams,
  MovingAverageParams,
  RsiParams,
} from '@shared/types';
import { DEFAULT_PARAMS, PERIOD_MAX, PERIOD_MIN } from '../indicators/types';

export const INDICATOR_KINDS: readonly IndicatorKind[] = ['sma', 'ema', 'rsi', 'macd'];

export const KIND_LABEL: Record<IndicatorKind, string> = {
  sma: 'SMA',
  ema: 'EMA',
  rsi: 'RSI',
  macd: 'MACD',
};

export const MA_SOURCES = ['open', 'high', 'low', 'close'] as const;

/** Signal line colour for MACD. `IndicatorConfig` carries one colour; the second line gets a fixed one. */
export const MACD_SIGNAL_COLOR = '#ff9800';

/** Distinct, legible on the dark theme; a new indicator takes the first colour not already in use. */
export const PALETTE: readonly string[] = [
  '#2962ff',
  '#e91e63',
  '#00bcd4',
  '#ffeb3b',
  '#9c27b0',
  '#8bc34a',
  '#ff5722',
  '#607d8b',
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

// ───────────────────────────── ids ─────────────────────────────

let counter = 0;
/** Client-generated, unique within and across sessions (persisted ids must not collide with new ones). */
export function newIndicatorId(): string {
  counter += 1;
  return `ind-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ───────────────────────────── params ─────────────────────────────

/** Editable numeric fields per kind, in display order. */
export const PARAM_FIELDS: Record<IndicatorKind, readonly { key: string; label: string }[]> = {
  sma: [{ key: 'period', label: 'Period' }],
  ema: [{ key: 'period', label: 'Period' }],
  rsi: [{ key: 'period', label: 'Period' }],
  macd: [
    { key: 'fastPeriod', label: 'Fast' },
    { key: 'slowPeriod', label: 'Slow' },
    { key: 'signalPeriod', label: 'Signal' },
  ],
};

export function defaultParams(kind: IndicatorKind): IndicatorParams {
  // Copies, so an edit can never mutate the frozen-by-convention defaults.
  switch (kind) {
    case 'sma':
      return { ...DEFAULT_PARAMS.sma };
    case 'ema':
      return { ...DEFAULT_PARAMS.ema };
    case 'rsi':
      return { ...DEFAULT_PARAMS.rsi };
    case 'macd':
      return { ...DEFAULT_PARAMS.macd };
  }
}

export type ParamErrors = Partial<Record<string, string>>;

function periodError(label: string, value: number): string | null {
  if (!Number.isInteger(value)) return `${label} must be a whole number.`;
  if (value < PERIOD_MIN || value > PERIOD_MAX) {
    return `${label} must be between ${PERIOD_MIN} and ${PERIOD_MAX}.`;
  }
  return null;
}

/**
 * Per-field validation errors; an empty object means valid. Mirrors the math module's
 * rules (integer periods in [PERIOD_MIN, PERIOD_MAX], MACD `fast < slow`) so the editor
 * rejects exactly what `computeIndicator` would throw on.
 */
export function validateParams(kind: IndicatorKind, params: Record<string, number>): ParamErrors {
  const errors: ParamErrors = {};
  for (const { key, label } of PARAM_FIELDS[kind]) {
    const value = params[key];
    const message = value === undefined ? `${label} is required.` : periodError(label, value);
    if (message) errors[key] = message;
  }
  if (kind === 'macd') {
    const fast = params['fastPeriod'];
    const slow = params['slowPeriod'];
    if (!errors['fastPeriod'] && !errors['slowPeriod'] && fast !== undefined && slow !== undefined && fast >= slow) {
      errors['fastPeriod'] = 'Fast period must be less than slow period.';
      errors['slowPeriod'] = 'Slow period must be greater than fast period.';
    }
  }
  return errors;
}

/** Text typed into a field -> number, or null when it is not a whole number at all. */
export function parseWholeNumber(text: string): number | null {
  return /^\s*-?\d+\s*$/.test(text) ? Number(text) : null;
}

/** Numeric view of params for validation, regardless of kind. */
export function numericParams(params: IndicatorParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'number') out[k] = v;
  return out;
}

// Narrowing helpers: IndicatorParams is a structural union with no discriminant.
export function isMacdParams(p: IndicatorParams): p is MacdParams {
  return 'fastPeriod' in p;
}
export function isMovingAverageParams(p: IndicatorParams): p is MovingAverageParams {
  return 'period' in p;
}

/** A params object shaped for `kind` built from untrusted input, or null if it is not valid for it. */
export function sanitizeParams(kind: IndicatorKind, raw: unknown): IndicatorParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const nums: Record<string, number> = {};
  for (const { key } of PARAM_FIELDS[kind]) {
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    nums[key] = v;
  }
  if (Object.keys(validateParams(kind, nums)).length > 0) return null;
  if (kind === 'macd') {
    return {
      fastPeriod: nums['fastPeriod'] ?? 0,
      slowPeriod: nums['slowPeriod'] ?? 0,
      signalPeriod: nums['signalPeriod'] ?? 0,
    };
  }
  if (kind === 'rsi') return { period: nums['period'] ?? 0 };
  const source = rec['source'];
  const valid = MA_SOURCES.find((s) => s === source);
  return { period: nums['period'] ?? 0, source: valid ?? 'close' };
}

// ───────────────────────────── instances ─────────────────────────────

export function pickColor(existing: readonly IndicatorConfig[]): string {
  const used = new Set(existing.map((c) => c.color.toLowerCase()));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[existing.length % PALETTE.length] ?? '#2962ff';
}

export function createIndicator(kind: IndicatorKind, existing: readonly IndicatorConfig[]): IndicatorConfig {
  return {
    id: newIndicatorId(),
    kind,
    params: defaultParams(kind),
    color: pickColor(existing),
    visible: true,
  };
}

/** "SMA (20)", "MACD (12, 26, 9)". */
export function indicatorTitle(config: Pick<IndicatorConfig, 'kind' | 'params'>): string {
  const p = config.params;
  const name = KIND_LABEL[config.kind];
  if (isMacdParams(p)) return `${name} (${p.fastPeriod}, ${p.slowPeriod}, ${p.signalPeriod})`;
  if (isMovingAverageParams(p) && p.source && p.source !== 'close') return `${name} (${p.period}, ${p.source})`;
  return `${name} (${(p as RsiParams).period})`;
}
