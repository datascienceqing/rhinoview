import { useState } from 'react';
import type { IndicatorConfig, IndicatorParams } from '@shared/types';
import { t, useI18n } from '../i18n';
import { PERIOD_MAX, PERIOD_MIN } from '../indicators/types';
import {
  PARAM_CHOICES,
  PARAM_FIELDS,
  choiceValues,
  fieldBounds,
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
  for (const { key, labelKey } of PARAM_FIELDS[kind]) {
    const n = parseWholeNumber(drafts[key] ?? '');
    if (n === null) errors[key] = t('param.wholeNumber', { label: t(labelKey) });
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
  // `tr` re-renders this editor when the language changes; `draftErrors` reads the same language.
  const { t: tr } = useI18n();
  const [drafts, setDrafts] = useState<Drafts>(() =>
    Object.fromEntries(Object.entries(numericParams(params)).map(([k, v]) => [k, String(v)])),
  );
  const { errors } = draftErrors(kind, drafts);
  // Select fields come from the kind, not the params shape: RSI's `{ period }` looks like an MA's.
  const choices = choiceValues(kind, params as unknown as Record<string, unknown>) ?? {};

  function edit(key: string, text: string) {
    const next = { ...drafts, [key]: text };
    setDrafts(next);
    const { values } = draftErrors(kind, next);
    if (!values) return;
    const valid = sanitizeParams(kind, { ...values, ...choices });
    if (valid) onChange(valid);
  }

  /** A select change applies at once, with the last valid numbers. */
  function choose(key: string, value: string) {
    const valid = sanitizeParams(kind, { ...numericParams(params), ...choices, [key]: value });
    if (valid) onChange(valid);
  }

  /** Last valid number for a field, to place its slider and bound the others. */
  const current = (key: string): number => {
    const draft = parseWholeNumber(drafts[key] ?? '');
    const field = PARAM_FIELDS[kind].find((f) => f.key === key);
    const own = field ? fieldBounds(field) : { min: PERIOD_MIN, max: PERIOD_MAX };
    if (draft !== null && draft >= own.min && draft <= own.max) return draft;
    return numericParams(params)[key] ?? own.min;
  };

  function bounds(key: string): { min: number; max: number } {
    if (kind !== 'macd') {
      const field = PARAM_FIELDS[kind].find((f) => f.key === key);
      return field ? fieldBounds(field) : { min: PERIOD_MIN, max: PERIOD_MAX };
    }
    if (key === 'fastPeriod') return { min: PERIOD_MIN, max: Math.max(PERIOD_MIN, Math.min(PERIOD_MAX, current('slowPeriod') - 1)) };
    if (key === 'slowPeriod') return { min: Math.min(PERIOD_MAX, current('fastPeriod') + 1), max: PERIOD_MAX };
    return { min: PERIOD_MIN, max: PERIOD_MAX };
  }

  return (
    <div className="params-editor">
      {PARAM_FIELDS[kind].map(({ key, labelKey }) => {
        const id = `${config.id}-${key}`;
        const label = tr(labelKey);
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
              min={kind === 'macd' ? PERIOD_MIN : min}
              max={kind === 'macd' ? PERIOD_MAX : max}
              value={drafts[key] ?? ''}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => edit(key, e.target.value)}
            />
            <input
              type="range"
              aria-label={tr('param.slider', { label })}
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
      {PARAM_CHOICES[kind].map(({ key, labelKey, options }) => {
        const id = `${config.id}-${key}`;
        return (
          <div className="param-field" key={key}>
            <label htmlFor={id}>{tr(labelKey)}</label>
            <select id={id} value={choices[key] ?? ''} onChange={(e) => choose(key, e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {tr(o.labelKey)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
