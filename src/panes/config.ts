import type {
  IndicatorConfig,
  IndicatorKind,
  IndicatorParams,
  MacdParams,
  LiquidityParams,
  MovingAverageParams,
  RsiParams,
  VpvrParams,
} from '@shared/types';
import { DEFAULT_PARAMS, LIQUIDITY_BOUNDS, PERIOD_MAX, PERIOD_MIN, VPVR_BOUNDS } from '../indicators/types';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export const INDICATOR_KINDS: readonly IndicatorKind[] = ['sma', 'ema', 'rsi', 'macd', 'volume', 'vpvr', 'liquidity'];

/** The kind's name in the current language. SMA, EMA, RSI, MACD and VRVP stay as they are. */
export function kindLabel(kind: IndicatorKind): string {
  return t(`indicator.kind.${kind}`);
}

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

/** One editable numeric field. Bounds default to PERIOD_MIN..PERIOD_MAX. */
export interface ParamField {
  key: string;
  labelKey: MessageKey;
  min?: number;
  max?: number;
}

/** Editable numeric fields per kind, in display order. */
export const PARAM_FIELDS: Record<IndicatorKind, readonly ParamField[]> = {
  sma: [{ key: 'period', labelKey: 'param.period' }],
  ema: [{ key: 'period', labelKey: 'param.period' }],
  rsi: [{ key: 'period', labelKey: 'param.period' }],
  macd: [
    { key: 'fastPeriod', labelKey: 'param.fast' },
    { key: 'slowPeriod', labelKey: 'param.slow' },
    { key: 'signalPeriod', labelKey: 'param.signal' },
  ],
  volume: [{ key: 'period', labelKey: 'param.maLength' }],
  vpvr: [
    { key: 'rows', labelKey: 'param.rows', ...VPVR_BOUNDS.rows },
    { key: 'widthPct', labelKey: 'param.widthPct', ...VPVR_BOUNDS.widthPct },
    { key: 'valueAreaPct', labelKey: 'param.valueAreaPct', ...VPVR_BOUNDS.valueAreaPct },
  ],
  liquidity: [
    { key: 'lookback', labelKey: 'param.lookback', ...LIQUIDITY_BOUNDS.lookback },
    { key: 'minTouches', labelKey: 'param.minTouches', ...LIQUIDITY_BOUNDS.minTouches },
    { key: 'maxAge', labelKey: 'param.maxAge', ...LIQUIDITY_BOUNDS.maxAge },
    { key: 'sweepExtend', labelKey: 'param.sweepExtend', ...LIQUIDITY_BOUNDS.sweepExtend },
  ],
};

/** One select field: a string param with a fixed set of values. */
export interface ParamChoice {
  key: string;
  labelKey: MessageKey;
  options: readonly { value: string; labelKey: MessageKey }[];
  /** A required choice makes stored params invalid when it is missing or unknown. */
  required: boolean;
  /** The value an optional choice takes when it is missing or unknown. */
  fallback: string;
}

const MA_SOURCE_CHOICE: ParamChoice = {
  key: 'source',
  labelKey: 'param.source',
  options: MA_SOURCES.map((s) => ({ value: s, labelKey: `param.source.${s}` as const })),
  required: false,
  fallback: 'close',
};

/** Select fields per kind, in display order, shown after the number fields. */
export const PARAM_CHOICES: Record<IndicatorKind, readonly ParamChoice[]> = {
  sma: [MA_SOURCE_CHOICE],
  ema: [MA_SOURCE_CHOICE],
  rsi: [],
  macd: [],
  volume: [],
  vpvr: [],
  liquidity: [
    {
      key: 'zoneMode',
      labelKey: 'param.zoneMode',
      options: [
        { value: 'wick', labelKey: 'param.zoneMode.wick' },
        { value: 'range', labelKey: 'param.zoneMode.range' },
      ],
      required: true,
      fallback: DEFAULT_PARAMS.liquidity.zoneMode,
    },
    {
      key: 'sweepMode',
      labelKey: 'param.sweepMode',
      options: [
        { value: 'wicks', labelKey: 'param.sweepMode.wicks' },
        { value: 'retests', labelKey: 'param.sweepMode.retests' },
        { value: 'both', labelKey: 'param.sweepMode.both' },
      ],
      required: true,
      fallback: DEFAULT_PARAMS.liquidity.sweepMode,
    },
  ],
};

/** The value of each select field of `kind` in `raw`, or null when a required one is missing or unknown. */
export function choiceValues(kind: IndicatorKind, raw: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const choice of PARAM_CHOICES[kind]) {
    const value = choice.options.find((o) => o.value === raw[choice.key])?.value;
    if (value === undefined && choice.required) return null;
    out[choice.key] = value ?? choice.fallback;
  }
  return out;
}

/** The bounds of a field: its own, or the period bounds. */
export function fieldBounds(field: ParamField): { min: number; max: number } {
  return { min: field.min ?? PERIOD_MIN, max: field.max ?? PERIOD_MAX };
}

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
    case 'volume':
      return { ...DEFAULT_PARAMS.volume };
    case 'vpvr':
      return { ...DEFAULT_PARAMS.vpvr };
    case 'liquidity':
      return { ...DEFAULT_PARAMS.liquidity };
  }
}

export type ParamErrors = Partial<Record<string, string>>;

function periodError(label: string, value: number, min = PERIOD_MIN, max = PERIOD_MAX): string | null {
  if (!Number.isInteger(value)) return t('param.wholeNumber', { label });
  if (value < min || value > max) {
    return t('param.between', { label, min, max });
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
  for (const field of PARAM_FIELDS[kind]) {
    const { key } = field;
    const label = t(field.labelKey);
    const { min, max } = fieldBounds(field);
    const value = params[key];
    const message = value === undefined ? t('param.required', { label }) : periodError(label, value, min, max);
    if (message) errors[key] = message;
  }
  if (kind === 'macd') {
    const fast = params['fastPeriod'];
    const slow = params['slowPeriod'];
    if (!errors['fastPeriod'] && !errors['slowPeriod'] && fast !== undefined && slow !== undefined && fast >= slow) {
      errors['fastPeriod'] = t('param.fastLess');
      errors['slowPeriod'] = t('param.slowGreater');
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
export function isVpvrParams(p: IndicatorParams): p is VpvrParams {
  return 'rows' in p;
}
export function isLiquidityParams(p: IndicatorParams): p is LiquidityParams {
  return 'lookback' in p;
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
  const choices = choiceValues(kind, rec);
  if (!choices) return null;
  if (kind === 'macd') {
    return {
      fastPeriod: nums['fastPeriod'] ?? 0,
      slowPeriod: nums['slowPeriod'] ?? 0,
      signalPeriod: nums['signalPeriod'] ?? 0,
    };
  }
  if (kind === 'rsi' || kind === 'volume') return { period: nums['period'] ?? 0 };
  if (kind === 'vpvr') {
    return { rows: nums['rows'] ?? 0, widthPct: nums['widthPct'] ?? 0, valueAreaPct: nums['valueAreaPct'] ?? 0 };
  }
  if (kind === 'liquidity') {
    return {
      lookback: nums['lookback'] ?? 0,
      zoneMode: choices['zoneMode'] as LiquidityParams['zoneMode'],
      sweepMode: choices['sweepMode'] as LiquidityParams['sweepMode'],
      minTouches: nums['minTouches'] ?? 0,
      maxAge: nums['maxAge'] ?? 0,
      sweepExtend: nums['sweepExtend'] ?? 0,
    };
  }
  return { period: nums['period'] ?? 0, source: choices['source'] as MovingAverageParams['source'] };
}

// ───────────────────────────── instances ─────────────────────────────

export function pickColor(existing: readonly IndicatorConfig[]): string {
  const used = new Set(existing.map((c) => c.color.toLowerCase()));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[existing.length % PALETTE.length] ?? '#2962ff';
}

/**
 * VRVP's colour is its up colour, against the theme's red for down. It always starts
 * blue, like Vela: a palette pick could give pink, which is hard to tell from red.
 */
export const VPVR_DEFAULT_COLOR = '#2962ff';

export function createIndicator(kind: IndicatorKind, existing: readonly IndicatorConfig[]): IndicatorConfig {
  return {
    id: newIndicatorId(),
    kind,
    params: defaultParams(kind),
    color: kind === 'vpvr' ? VPVR_DEFAULT_COLOR : pickColor(existing),
    visible: true,
  };
}

/** "SMA (20)", "MACD (12, 26, 9)". */
export function indicatorTitle(config: Pick<IndicatorConfig, 'kind' | 'params'>): string {
  const p = config.params;
  const name = kindLabel(config.kind);
  if (isMacdParams(p)) return t('indicator.title', { name, args: `${p.fastPeriod}, ${p.slowPeriod}, ${p.signalPeriod}` });
  if (isVpvrParams(p)) return t('indicator.title.vpvr', { name, rows: p.rows });
  // D2: "Liquidity" in the menu, "LIQ (10)" as the title.
  if (isLiquidityParams(p)) return t('indicator.title.liquidity', { lookback: p.lookback });
  if (isMovingAverageParams(p) && p.source && p.source !== 'close') {
    return t('indicator.title', { name, args: `${p.period}, ${t(`param.source.${p.source}`)}` });
  }
  return t('indicator.title', { name, args: String((p as RsiParams).period) });
}
