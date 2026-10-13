/**
 * Create or edit an alert (docs/ALERTS_PLAN.md, sections 4.2 and 4.3).
 *
 * Defaults: Crossing, Once, 1 month, an empty message (the app then writes the default
 * text, shown as the placeholder). The same `checkAlertCondition` as the server checks the
 * fields while the user types.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AlertCondition, AlertDirection, AlertExpiry, AlertFrequency, AlertTarget, UpdateAlertBody } from '@shared/types';
import { ALERT_EXPIRY_CHOICES, DEFAULT_ALERT_EXPIRY, MAX_ALERT_MESSAGE_LENGTH } from '@shared/types';
import { DataError } from '../data/errors';
import { INTL_LOCALE, useI18n } from '../i18n';
import { LINE_KEYS } from '../indicators/types';
import { indicatorTitle } from '../panes/config';
import { describeError } from '../ui/errorCopy';
import { useAlerts } from './AlertsProvider';
import type { AlertDraft } from './AlertsProvider';
import { CLOSE_TARGET_KINDS, checkAlertCondition, checkAlertMessage, directionOf } from './condition';
import { defaultMessage, formatLevel, latchDateText } from './describe';
import { computeExpiresAt } from './expiry';

const DIRECTIONS: readonly AlertDirection[] = ['cross', 'up', 'down'];

/** The level as the field shows it: "190.00", but every digit of a sub-cent level ("0.1234"). */
const levelText = (level: number) => (Number(level.toFixed(2)) === level ? level.toFixed(2) : String(level));

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
  const { create, update } = useAlerts();
  const id = useId();
  const first = useRef<HTMLSelectElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const editing = draft.id !== undefined;

  const [direction, setDirection] = useState<AlertDirection>(directionOf(draft.condition));
  // A confluence alert keeps the level the latch locked: the dialog shows it, and cannot change it.
  const confluence = draft.condition.type === 'confluence' ? draft.condition : null;
  const [level, setLevel] = useState(draft.condition.type === 'price' ? levelText(draft.condition.level) : '');
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

  // A confluence alert has no condition field: the first input (the trigger) takes the focus.
  useEffect(() => (first.current ?? form.current?.querySelector('input'))?.focus(), []);

  const otherLines = lines.filter((l) => l !== line);
  // The close is a target only for indicators on the price scale. An old alert that has it
  // keeps the option, so the dialog shows its real target.
  const closeAllowed = indicator !== null && (CLOSE_TARGET_KINDS.includes(indicator.indicator.kind) || indicator.target.type === 'close');

  let condition: AlertCondition;
  if (confluence) {
    condition = confluence;
  } else if (!indicator) {
    condition = { type: 'price', direction, level: toNumber(level) };
  } else {
    let target: AlertTarget;
    if (targetType === 'close') target = { type: 'close' };
    else if (targetType === 'line') target = { type: 'line', line: otherLines.includes(targetLine) ? targetLine : (otherLines[0] ?? '') };
    else target = { type: 'value', value: toNumber(value) };
    condition = { ...indicator, line, direction, target };
  }

  // An unchanged condition of a saved alert passes the rules of its time (see `stored`).
  const unchanged = editing && JSON.stringify(condition) === JSON.stringify(draft.condition);
  const conditionProblem = checkAlertCondition(condition, { stored: unchanged });
  const problem = conditionProblem ?? checkAlertMessage(message);
  const expiresAt = computeExpiresAt(Math.floor(Date.now() / 1000), expiry);
  const expiresText = new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'medium' }).format(expiresAt * 1000);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        // Only the fields that changed: a new `condition` resets the side, and a new `expiry`
        // counts from now, so a message edit must not send them.
        const changes: UpdateAlertBody = { revision: draft.revision as number };
        if (JSON.stringify(condition) !== JSON.stringify(draft.condition)) changes.condition = condition;
        if (frequency !== (draft.frequency ?? 'once')) changes.frequency = frequency;
        if (expiry !== (draft.expiry ?? DEFAULT_ALERT_EXPIRY)) changes.expiry = expiry;
        if (message !== (draft.message ?? '')) changes.message = message;
        if (Object.keys(changes).length > 1) await update(draft.id as string, changes);
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
        ref={form}
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
            {confluence && ` · ${indicatorTitle({ kind: 'confluence', params: confluence.params })} · ${t(`timeframe.${confluence.timeframe}`)}`}
          </span>
        </h2>

        {confluence && (
          <>
            <div className="alert-field">
              <span>{t('alerts.field.condition')}</span>
              <output>{t(`alerts.confluence.${confluence.params.mode}`, { level: formatLevel(confluence.lock.top), count: confluence.lock.count })}</output>
            </div>
            <div className="alert-field">
              <span>{t('alerts.field.latchDate')}</span>
              <output>{latchDateText(confluence)}</output>
              <small className="alert-hint">{t('alerts.confluence.hint')}</small>
            </div>
          </>
        )}

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

        {!confluence && (
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
        )}

        {!indicator && !confluence && (
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
              {closeAllowed && <option value="close">{t('alerts.target.close')}</option>}
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

        <div className="alert-field">
          <span id={`${id}-trigger`}>{t('alerts.field.trigger')}</span>
          <div className="alert-radios" role="radiogroup" aria-labelledby={`${id}-trigger`}>
            {(['once', 'every'] as const).map((f) => (
              <label key={f}>
                <input type="radio" name={`${id}-frequency`} checked={frequency === f} onChange={() => setFrequency(f)} />
                {t(`alerts.frequency.${f}`)}
              </label>
            ))}
          </div>
        </div>

        <div className="alert-field">
          <label htmlFor={`${id}-expiry`}>{t('alerts.field.expiry')}</label>
          <select id={`${id}-expiry`} aria-describedby={`${id}-expires`} value={expiry} onChange={(e) => setExpiry(e.target.value as AlertExpiry)}>
            {ALERT_EXPIRY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {t(`alerts.expiry.${c}`)}
              </option>
            ))}
          </select>
          <small id={`${id}-expires`} className="alert-hint">
            {t('alerts.expiresOn', { date: expiresText })}
          </small>
        </div>

        <label className="alert-field">
          <span>{t('alerts.field.message')}</span>
          <input
            type="text"
            maxLength={MAX_ALERT_MESSAGE_LENGTH}
            value={message}
            placeholder={conditionProblem === null ? defaultMessage(draft.symbol, condition) : ''}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        {error && (
          <p className="alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="alert-dialog-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button" disabled={problem !== null || saving}>
            {editing ? t('alerts.save') : t('alerts.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
