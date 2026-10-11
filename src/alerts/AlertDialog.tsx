/**
 * Create or edit an alert (docs/ALERTS_PLAN.md, sections 4.2 and 4.3).
 *
 * Defaults: Crossing, Once, 1 month, an empty message (the app then writes the default
 * text, shown as the placeholder). The same `checkAlertCondition` as the server checks the
 * fields while the user types.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AlertCondition, AlertDirection, AlertExpiry, AlertFrequency, AlertTarget } from '@shared/types';
import { ALERT_EXPIRY_CHOICES, DEFAULT_ALERT_EXPIRY, MAX_ALERT_MESSAGE_LENGTH, MAX_ALERTS } from '@shared/types';
import { DataError } from '../data/errors';
import { INTL_LOCALE, useI18n } from '../i18n';
import { LINE_KEYS } from '../indicators/types';
import { indicatorTitle } from '../panes/config';
import { describeError } from '../ui/errorCopy';
import { useAlerts } from './AlertsProvider';
import type { AlertDraft } from './AlertsProvider';
import { checkAlertCondition, checkAlertMessage } from './condition';
import { defaultMessage } from './describe';
import { computeExpiresAt } from './expiry';

const DIRECTIONS: readonly AlertDirection[] = ['cross', 'up', 'down'];

/** The number in a field: an empty or partial entry is NaN, which the check rejects. */
const toNumber = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

export function AlertDialog() {
  const { dialog, closeDialog } = useAlerts();
  if (!dialog) return null;
  // A new key for each draft, so the fields start from the draft each time.
  return <AlertDialogForm key={dialog.id ?? `${dialog.symbol}-${JSON.stringify(dialog.condition)}`} draft={dialog} onClose={closeDialog} />;
}

function AlertDialogForm({ draft, onClose }: { draft: AlertDraft; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { alerts, create, update } = useAlerts();
  const id = useId();
  const first = useRef<HTMLSelectElement>(null);
  const editing = draft.id !== undefined;

  const [direction, setDirection] = useState<AlertDirection>(draft.condition.direction);
  const [level, setLevel] = useState(draft.condition.type === 'price' ? draft.condition.level.toFixed(2) : '');
  const indicator = draft.condition.type === 'indicator' ? draft.condition : null;
  const lines = indicator ? LINE_KEYS[indicator.indicator.kind] : [];
  const [line, setLine] = useState(indicator?.line ?? '');
  const [targetType, setTargetType] = useState<AlertTarget['type']>(indicator?.target.type ?? 'value');
  const [targetLine, setTargetLine] = useState(indicator?.target.type === 'line' ? indicator.target.line : '');
  const [value, setValue] = useState(indicator?.target.type === 'value' ? String(indicator.target.value) : '');
  const [frequency, setFrequency] = useState<AlertFrequency>(draft.frequency ?? 'once');
  const [expiry, setExpiry] = useState<AlertExpiry>(draft.expiry ?? DEFAULT_ALERT_EXPIRY);
  const [message, setMessage] = useState(draft.message ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => first.current?.focus(), []);

  const otherLines = lines.filter((l) => l !== line);

  let condition: AlertCondition;
  if (!indicator) {
    condition = { type: 'price', direction, level: toNumber(level) };
  } else {
    let target: AlertTarget;
    if (targetType === 'close') target = { type: 'close' };
    else if (targetType === 'line') target = { type: 'line', line: otherLines.includes(targetLine) ? targetLine : (otherLines[0] ?? '') };
    else target = { type: 'value', value: toNumber(value) };
    condition = { ...indicator, line, direction, target };
  }

  const problem = checkAlertCondition(condition) ?? checkAlertMessage(message);
  const full = !editing && alerts.length >= MAX_ALERTS;
  const expiresAt = computeExpiresAt(Math.floor(Date.now() / 1000), expiry);
  const expiresText = new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'medium' }).format(expiresAt * 1000);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem || saving || full) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await update(draft.id as string, { revision: draft.revision as number, condition, frequency, expiry, message });
      } else {
        await create({ symbol: draft.symbol, condition, frequency, expiry, message });
      }
      onClose();
    } catch (err) {
      const reason = err instanceof DataError ? describeError(err, 'alerts').title : String(err);
      setError(t('alerts.saveFailed', { reason }));
      setSaving(false);
    }
  }

  const lineLabel = (key: string) => (key === 'value' ? (indicator ? indicatorTitle(indicator.indicator) : key) : t(`indicator.line.${key}` as 'indicator.line.macd'));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="alert-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id={`${id}-title`} className="alert-dialog-title">
          {editing ? t('alerts.dialog.edit') : t('alerts.dialog.new')}
          <span className="alert-dialog-symbol">
            {draft.symbol}
            {indicator && ` · ${indicatorTitle(indicator.indicator)} · ${t(`timeframe.${indicator.timeframe}`)}`}
          </span>
        </h2>

        {indicator && lines.length > 1 && (
          <label className="alert-field">
            <span>{t('alerts.field.line')}</span>
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              {lines.map((l) => (
                <option key={l} value={l}>
                  {lineLabel(l)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="alert-field">
          <span>{t('alerts.field.condition')}</span>
          <select ref={first} value={direction} onChange={(e) => setDirection(e.target.value as AlertDirection)}>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`alerts.direction.${d}`)}
              </option>
            ))}
          </select>
        </label>

        {!indicator && (
          <label className="alert-field">
            <span>{t('alerts.field.price')}</span>
            <input type="number" inputMode="decimal" step="0.01" min="0" value={level} onChange={(e) => setLevel(e.target.value)} />
          </label>
        )}

        {indicator && (
          <label className="alert-field">
            <span>{t('alerts.field.target')}</span>
            <select value={targetType} onChange={(e) => setTargetType(e.target.value as AlertTarget['type'])}>
              <option value="value">{t('alerts.target.value')}</option>
              <option value="close">{t('alerts.target.close')}</option>
              {otherLines.length > 0 && <option value="line">{t('alerts.target.line', { name: lineLabel(otherLines.includes(targetLine) ? targetLine : (otherLines[0] as string)) })}</option>}
            </select>
          </label>
        )}

        {indicator && targetType === 'value' && (
          <label className="alert-field">
            <span>{t('alerts.field.value')}</span>
            <input type="number" inputMode="decimal" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}

        {indicator && targetType === 'line' && otherLines.length > 1 && (
          <label className="alert-field">
            <span>{t('alerts.field.line')}</span>
            <select value={otherLines.includes(targetLine) ? targetLine : otherLines[0]} onChange={(e) => setTargetLine(e.target.value)}>
              {otherLines.map((l) => (
                <option key={l} value={l}>
                  {lineLabel(l)}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="alert-field alert-radios">
          <legend>{t('alerts.field.trigger')}</legend>
          {(['once', 'every'] as const).map((f) => (
            <label key={f}>
              <input type="radio" name={`${id}-frequency`} checked={frequency === f} onChange={() => setFrequency(f)} />
              {t(`alerts.frequency.${f}`)}
            </label>
          ))}
        </fieldset>

        <label className="alert-field">
          <span>{t('alerts.field.expiry')}</span>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as AlertExpiry)}>
            {ALERT_EXPIRY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {t(`alerts.expiry.${c}`)}
              </option>
            ))}
          </select>
          <small className="alert-hint">{t('alerts.expiresOn', { date: expiresText })}</small>
        </label>

        <label className="alert-field">
          <span>{t('alerts.field.message')}</span>
          <input
            type="text"
            maxLength={MAX_ALERT_MESSAGE_LENGTH}
            value={message}
            placeholder={checkAlertCondition(condition) === null ? defaultMessage(draft.symbol, condition) : ''}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        {full && (
          <p className="alert-error" role="alert">
            {t('alerts.limit', { max: MAX_ALERTS })}
          </p>
        )}
        {error && (
          <p className="alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="alert-dialog-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button" disabled={problem !== null || saving || full}>
            {editing ? t('alerts.save') : t('alerts.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
