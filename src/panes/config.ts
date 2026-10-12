import type {
  ConfluenceParams,
  IndicatorConfig,
  IndicatorKind,
  IndicatorParams,
  MacdParams,
  LiquidityParams,
  MovingAverageParams,
  RsiParams,
  VpvrParams,
} from '@shared/types';
import { CONFLUENCE_BOUNDS, DEFAULT_PARAMS, LIQUIDITY_BOUNDS, PERIOD_MAX, PERIOD_MIN, VPVR_BOUNDS } from '../indicators/types';
import { checkIndicatorParams } from '../indicators/params';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export const INDICATOR_KINDS: readonly IndicatorKind[] = ['sma', 'ema', 'rsi', 'macd', 'volume', 'vpvr', 'liquidity', 'confluence'];

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
  /** Below 1 makes a decimal field: any number in the bounds. Default 1, a whole number. */
  step?: number;
  /** Shown only while the select field `key` has `value`. A hidden field keeps its value. */
  when?: { key: string; value: string };
}

/** A decimal field accepts fractions; the others accept whole numbers only. */
export function isDecimalField(field: ParamField): boolean {
  return (field.step ?? 1) < 1;
}

/** Confluence number fields with the bounds of the param check, and a step for the decimals. */
const conf = (
  key: keyof typeof CONFLUENCE_BOUNDS,
  labelKey: MessageKey,
  step?: number,
  when?: ParamField['when'],
): ParamField => {
  const { min, max } = CONFLUENCE_BOUNDS[key];
  return { key, labelKey, min, max, ...(step === undefined ? {} : { step }), ...(when ? { when } : {}) };
};
const TURN = { key: 'mode', value: 'turn' };
const BREAKDOWN = { key: 'mode', value: 'breakdown' };

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
  // D2: each mode has its own minimum confluence and distance; close quality is breakdown only.
  confluence: [
    conf('swingLookback', 'param.swingLookback'),
    conf('tolerancePct', 'param.tolerancePct', 0.05),
    conf('bandWidthMult', 'param.bandWidthMult', 0.5),
    conf('pivotLeft', 'param.pivotLeft'),
    conf('pivotRight', 'param.pivotRight'),
    conf('pivotMaxAge', 'param.pivotMaxAge'),
    conf('turnMinConfluence', 'param.minConfluence', undefined, TURN),
    conf('turnMinDistancePct', 'param.minDistancePct', 0.1, TURN),
    conf('breakdownMinConfluence', 'param.minConfluence', undefined, BREAKDOWN),
    conf('breakdownMinDistancePct', 'param.minDistancePct', 0.1, BREAKDOWN),
    conf('volumeLength', 'param.volumeLength'),
    conf('volumeMult', 'param.volumeMult', 0.1),
    conf('closeQuality', 'param.closeQuality', 0.05, BREAKDOWN),
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
  /** Shown before the number fields, because it decides which of them show. */
  first?: boolean;
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
  confluence: [
    {
      key: 'mode',
      labelKey: 'param.mode',
      options: [
        { value: 'turn', labelKey: 'param.mode.turn' },
        { value: 'breakdown', labelKey: 'param.mode.breakdown' },
      ],
      required: true,
      fallback: DEFAULT_PARAMS.confluence.mode,
      first: true,
    },
    {
      key: 'sources',
      labelKey: 'param.sources',
      options: [
        { value: 'both', labelKey: 'param.sources.both' },
        { value: 'fibs', labelKey: 'param.sources.fibs' },
        { value: 'mas', labelKey: 'param.sources.mas' },
        { value: 'none', labelKey: 'param.sources.none' },
      ],
      required: true,
      fallback: DEFAULT_PARAMS.confluence.sources,
    },
    {
      key: 'latch',
      labelKey: 'param.latch',
      options: [
        { value: 'off', labelKey: 'param.latch.off' },
        { value: 'on', labelKey: 'param.latch.on' },
      ],
      required: true,
      fallback: DEFAULT_PARAMS.confluence.latch,
    },
  ],
};

/** Whether `field` shows for the current select values (`choiceValues`). */
export function isFieldShown(field: ParamField, choices: Readonly<Record<string, string>>): boolean {
  return field.when === undefined || choices[field.when.key] === field.when.value;
}

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
    case 'confluence':
      return { ...DEFAULT_PARAMS.confluence };
  }
}

export type ParamErrors = Partial<Record<string, string>>;

function periodError(label: string, value: number, min = PERIOD_MIN, max = PERIOD_MAX, decimal = false): string | null {
  if (decimal ? !Number.isFinite(value) : !Number.isInteger(value)) {
    return t(decimal ? 'param.number' : 'param.wholeNumber', { label });
  }
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
    const message =
      value === undefined ? t('param.required', { label }) : periodError(label, value, min, max, isDecimalField(field));
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

/** Text typed into a decimal field -> number, or null. Accepts "0.75", ".5" and "2"; not "1e3". */
export function parseDecimal(text: string): number | null {
  return /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(text) ? Number(text) : null;
}

/** The parser for a field's text. */
export function parseFieldText(field: ParamField, text: string): number | null {
  return isDecimalField(field) ? parseDecimal(text) : parseWholeNumber(text);
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
/** Tested before the helpers above: confluence has no `lookback` or `period` key, on purpose. */
export function isConfluenceParams(p: IndicatorParams): p is ConfluenceParams {
  return 'swingLookback' in p;
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
  if (kind === 'confluence') {
    // `latchTime` is not an editor field: only the latch handle sets it. Keep it through edits.
    const latchTime = rec['latchTime'] ?? 0;
    const out = { ...DEFAULT_PARAMS.confluence, ...nums, ...choices, latchTime } as ConfluenceParams;
    return checkIndicatorParams('confluence', out) === null ? out : null;
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
  // D8: the mode stays in English in the title, like the kind names.
  if (isConfluenceParams(p)) {
    return t('indicator.title.confluence', { mode: p.mode === 'turn' ? 'Turn' : 'Breakdown', lookback: p.swingLookback });
  }
  if (isMacdParams(p)) return t('indicator.title', { name, args: `${p.fastPeriod}, ${p.slowPeriod}, ${p.signalPeriod}` });
  if (isVpvrParams(p)) return t('indicator.title.vpvr', { name, rows: p.rows });
  // D2: "Liquidity" in the menu, "LIQ (10)" as the title.
  if (isLiquidityParams(p)) return t('indicator.title.liquidity', { lookback: p.lookback });
  if (isMovingAverageParams(p) && p.source && p.source !== 'close') {
    return t('indicator.title', { name, args: `${p.period}, ${t(`param.source.${p.source}`)}` });
  }
  return t('indicator.title', { name, args: String((p as RsiParams).period) });
}
