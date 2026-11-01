/**
 * The AI panel (docs/AI_HELPER_PLAN.md, step C). It docks over the watchlist, like the
 * Alerts window, so the chart and its price scale stay visible while the marks appear.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_AI_QUESTION_LENGTH } from '@shared/types';
import { DIRECTION_ARROW, formatLevel } from '../alerts/describe';
import { useI18n } from '../i18n';
import { useAi } from './AiProvider';
import type { AiAlertsRun } from './AiProvider';
import { Markdown } from './Markdown';

export interface AiPanelProps {
  /** The symbol on the chart: the question is about it. */
  symbol: string;
}

export function AiPanel({ symbol }: AiPanelProps) {
  const { t } = useI18n();
  const { open, setOpen, analysis, ask, stop, showMarks, setShowMarks, clear, aiAlerts } = useAi();
  const [question, setQuestion] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open) return null;
  const busy = analysis?.status === 'loading' || analysis?.status === 'streaming';
  const presets = [t('ai.preset.long', { symbol }), t('ai.preset.short', { symbol }), t('ai.preset.entry', { symbol })];

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    ask(symbol, q);
  }

  const flagged = analysis?.check?.unknown ?? [];
  const otherSymbol = analysis && analysis.symbol !== symbol.toUpperCase();

  return (
    <section
      className="ai-panel"
      role="dialog"
      aria-label={t('ai.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <header className="ai-panel-bar">
        <span className="ai-panel-title">{t('ai.title')}</span>
        <span className="ai-panel-symbol">{symbol}</span>
        <button type="button" className="icon-button" aria-label={t('ai.close')} title={t('ai.close')} onClick={() => setOpen(false)}>
          ×
        </button>
      </header>

      <form className="ai-ask" onSubmit={submit}>
        <textarea
          ref={input}
          value={question}
          maxLength={MAX_AI_QUESTION_LENGTH}
          rows={2}
          placeholder={t('ai.placeholder', { symbol })}
          aria-label={t('ai.question')}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
        />
        <div className="ai-presets">
          {presets.map((p) => (
            <button key={p} type="button" className="ai-preset" disabled={busy} onClick={() => setQuestion(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="ai-ask-actions">
          {busy ? (
            <button type="button" className="button" onClick={stop}>
              {t('ai.stop')}
            </button>
          ) : (
            <button type="submit" className="button primary" disabled={!question.trim()}>
              {t('ai.ask')}
            </button>
          )}
        </div>
      </form>

      <div className="ai-answer" aria-live="polite" aria-busy={busy}>
        {aiAlerts && <AiAlertsSection run={aiAlerts} />}
        {!analysis && !aiAlerts && <p className="ai-hint">{t('ai.hint')}</p>}
        {analysis && (
          <>
            <p className="ai-asked">
              <span className="ai-asked-symbol">{analysis.symbol}</span> {analysis.question}
            </p>
            {otherSymbol && <p className="ai-note">{t('ai.otherSymbol', { symbol: analysis.symbol })}</p>}
            {analysis.synthetic && <p className="ai-badge synthetic">{t('ai.synthetic')}</p>}
            {analysis.stale && <p className="ai-badge warn">{t('ai.stale')}</p>}
            {analysis.status === 'loading' && <p className="ai-hint">{t('ai.loading')}</p>}
            {analysis.text && <Markdown text={analysis.text} flagged={flagged} flagTitle={t('ai.flaggedTitle')} />}
            {analysis.status === 'streaming' && <span className="ai-cursor" aria-hidden="true" />}
            {analysis.status === 'error' && <p className="ai-error" role="alert">{analysis.error ?? t('ai.broken')}</p>}
            {analysis.status === 'done' && analysis.check && (
              <p className={`ai-check${flagged.length ? ' warn' : ''}`}>
                {flagged.length
                  ? t('ai.check.flagged', { count: flagged.length, checked: analysis.check.checked })
                  : t('ai.check.ok', { checked: analysis.check.checked })}
              </p>
            )}
          </>
        )}
      </div>

      {analysis && (
        <footer className="ai-panel-foot">
          {analysis.marks && (
            <label className="ai-marks-toggle">
              <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} />
              {t('ai.showMarks', { count: analysis.marks.lines.length + analysis.marks.zones.length })}
            </label>
          )}
          <button type="button" className="link-button" onClick={clear}>
            {t('ai.clear')}
          </button>
        </footer>
      )}
    </section>
  );
}

/** The result of "AI alerts…": the added alerts, each with Remove, and the rejected levels with the reason. */
function AiAlertsSection({ run }: { run: AiAlertsRun }) {
  const { t } = useI18n();
  const { removeAiAlert, closeAiAlerts } = useAi();
  const r = run.result;
  return (
    <section className="ai-alerts" aria-label={t('ai.alerts.title', { symbol: run.symbol })}>
      <header className="ai-alerts-head">
        <h4>{t('ai.alerts.title', { symbol: run.symbol })}</h4>
        <button type="button" className="icon-button" aria-label={t('ai.alerts.close')} title={t('ai.alerts.close')} onClick={closeAiAlerts}>
          ×
        </button>
      </header>
      {run.status === 'loading' && <p className="ai-hint">{t('ai.alerts.loading')}</p>}
      {run.status === 'error' && <p className="ai-error" role="alert">{run.error}</p>}
      {r && (
        <>
          {r.synthetic && <p className="ai-badge synthetic">{t('ai.synthetic')}</p>}
          <p className="ai-alerts-count">
            {r.added.length ? t('ai.alerts.added', { count: r.added.length }) : run.removed ? t('ai.alerts.allRemoved', { count: run.removed }) : t('ai.alerts.none')}
          </p>
          <ul className="ai-alerts-list">
            {r.added.map((a) => (
              <li key={a.id}>
                <span className="ai-alert-level">
                  {a.condition.type === 'price' ? `${DIRECTION_ARROW[a.condition.direction]} ${formatLevel(a.condition.level)}` : ''}
                </span>
                <span className="ai-alert-msg">{a.message}</span>
                <button type="button" className="link-button" onClick={() => void removeAiAlert(a.id)}>
                  {t('ai.alerts.remove')}
                </button>
              </li>
            ))}
          </ul>
          {r.added.length > 0 && <p className="ai-hint">{t('ai.alerts.note')}</p>}
          {r.rejected.length > 0 && (
            <details className="ai-alerts-rejected">
              <summary>{t('ai.alerts.rejected', { count: r.rejected.length })}</summary>
              <ul>
                {r.rejected.map((x) => (
                  <li key={`${x.plan}-${x.role}-${x.level}`}>
                    {x.plan} {t(`ai.alerts.role.${x.role}`)} {formatLevel(x.level)}: {x.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

