import { useState } from 'react';
import type { IndicatorConfig, IndicatorParams } from '@shared/types';
import { PERIOD_MAX, PERIOD_MIN } from '../indicators/types';
import {
  MA_SOURCES,
  PARAM_FIELDS,
  isMovingAverageParams,
  numericParams,
  parseWholeNumber,
  sanitizeParams,
  validateParams,
} from './config';
import type { ParamErrors } from './config';

export interface ParamsEditorProps {
  config: IndicatorConfig;
  /** Called only with valid params. Invalid input is never passed on, clamped or corrected. */
  onChange: (params: IndicatorParams) => void;
}

type Drafts = Record<string, string>;

/** Everything wrong with the drafts right now: unparseable text first, then the range and MACD rules. */
function draftErrors(kind: IndicatorConfig['kind'], drafts: Drafts): { errors: ParamErrors; values: Record<string, number> | null } {
  const errors: ParamErrors = {};
  const values: Record<string, number> = {};
  for (const { key, label } of PARAM_FIELDS[kind]) {
    const n = parseWholeNumber(drafts[key] ?? '');
    if (n === null) errors[key] = `${label} must be a whole number.`;
    else values[key] = n;
  }
  if (Object.keys(errors).length > 0) return { errors, values: null };
  const rules = validateParams(kind, values);
  return { errors: rules, values: Object.keys(rules).length > 0 ? null : values };
}

/**
 * Number boxes plus sliders for an indicator's parameters. A valid edit applies
 * immediately (dragging a slider is live); an invalid one is shown with its reason
 * next to the field and is NOT applied, so the chart keeps the last valid setting
 * instead of silently moving to a corrected value. Sliders cannot produce an invalid
 * MACD pair: the fast slider stops below slow and the slow slider above fast.
 */
export function ParamsEditor({ config, onChange }: ParamsEditorProps) {
  const { kind, params } = config;
  const [drafts, setDrafts] = useState<Drafts>(() =>
    Object.fromEntries(Object.entries(numericParams(params)).map(([k, v]) => [k, String(v)])),
  );
  const { errors } = draftErrors(kind, drafts);
  // RSI's params are `{ period }` too, so the shape cannot tell an MA from an RSI; the kind can.
  const hasSource = (kind === 'sma' || kind === 'ema') && isMovingAverageParams(params);

  function edit(key: string, text: string) {
    const next = { ...drafts, [key]: text };
    setDrafts(next);
    const { values } = draftErrors(kind, next);
    if (!values) return;
    const source = hasSource ? params.source : undefined;
    const valid = sanitizeParams(kind, { ...values, source });
    if (valid) onChange(valid);
  }

  /** Last valid number for a field, to place its slider and bound the others. */
  const current = (key: string): number => {
    const draft = parseWholeNumber(drafts[key] ?? '');
    if (draft !== null && draft >= PERIOD_MIN && draft <= PERIOD_MAX) return draft;
    return numericParams(params)[key] ?? PERIOD_MIN;
  };

  function bounds(key: string): { min: number; max: number } {
    if (kind !== 'macd') return { min: PERIOD_MIN, max: PERIOD_MAX };
    if (key === 'fastPeriod') return { min: PERIOD_MIN, max: Math.max(PERIOD_MIN, Math.min(PERIOD_MAX, current('slowPeriod') - 1)) };
    if (key === 'slowPeriod') return { min: Math.min(PERIOD_MAX, current('fastPeriod') + 1), max: PERIOD_MAX };
    return { min: PERIOD_MIN, max: PERIOD_MAX };
  }

  return (
    <div className="params-editor">
      {PARAM_FIELDS[kind].map(({ key, label }) => {
        const id = `${config.id}-${key}`;
        const error = errors[key];
        const { min, max } = bounds(key);
        return (
          <div className="param-field" key={key}>
            <label htmlFor={id}>{label}</label>
            <input
              id={id}
              type="number"
              inputMode="numeric"
              step={1}
              min={PERIOD_MIN}
              max={PERIOD_MAX}
              value={drafts[key] ?? ''}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => edit(key, e.target.value)}
            />
            <input
              type="range"
              aria-label={`${label} slider`}
              min={min}
              max={max}
              step={1}
              value={current(key)}
              onChange={(e) => edit(key, e.target.value)}
            />
            {error && (
              <div className="param-error" id={`${id}-error`} role="alert">
                {error}
              </div>
            )}
          </div>
        );
      })}
      {hasSource && (
        <div className="param-field">
          <label htmlFor={`${config.id}-source`}>Source</label>
          <select
            id={`${config.id}-source`}
            value={params.source ?? 'close'}
            onChange={(e) => {
              const source = MA_SOURCES.find((s) => s === e.target.value);
              if (source) onChange({ ...params, source });
            }}
          >
            {MA_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
