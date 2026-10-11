/**
 * Named-layout switcher in the toolbar: pick a layout, or create, rename, duplicate or
 * delete one, and see whether the active layout is saved. All state lives in the
 * workspace provider (src/workspace); this component only drives it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_NAME_LENGTH } from '@shared/types';
import { useActiveChart, useLayouts } from '../workspace';
import type { ActionResult, LayoutsApi } from '../workspace';
import { useI18n } from '../i18n';
import './layouts.css';

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'rename' } | { kind: 'delete' };

const SAVE_LABEL = {
  saved: 'layout.saved',
  saving: 'layout.saving',
  error: 'layout.saveFailed',
} as const;

export function LayoutSwitcher() {
  const api = useLayouts();
  const { chart } = useActiveChart();
  // Under the in-memory provider there is nothing to manage: show the name only.
  if (!api) {
    return (
      <div className="layout-switcher" data-testid="layout-switcher">
        {chart.name}
      </div>
    );
  }
  return <Switcher api={api} activeName={chart.name} />;
}

function Switcher({ api, activeName }: { api: LayoutsApi; activeName: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  function close() {
    setOpen(false);
    setMode({ kind: 'list' });
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeId = api.activeId;

  /** Run an action; close on success, keep the panel open and say why on failure. */
  async function run(action: () => Promise<ActionResult>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) close();
    else setError(result.message);
  }

  function startMode(next: Mode, initial = '') {
    setMode(next);
    setDraft(initial);
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (name === '') {
      setError(t('layout.enterName'));
      return;
    }
    if (mode.kind === 'new') void run(() => api.create(name));
    else if (mode.kind === 'rename' && activeId !== null) void run(() => api.rename(activeId, name));
  }

  const nameForm = (label: string) => (
    <form className="layout-form" onSubmit={submit}>
      <label>
        {label}
        <input
          type="text"
          autoFocus
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          aria-invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="layout-form-actions">
        <button type="submit" className="button" disabled={busy}>
          {mode.kind === 'new' ? t('layout.create') : t('layout.renameSubmit')}
        </button>
        <button type="button" className="layout-plain" onClick={() => startMode({ kind: 'list' })}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="layout-switcher" data-testid="layout-switcher" ref={root}>
      <button
        type="button"
        className="layout-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('layout.button', { name: activeName })}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="layout-name">{activeName}</span>
        <span aria-hidden="true">▾</span>
      </button>

      <span
        className={`layout-save layout-save-${api.saveState}`}
        data-testid="layout-save-state"
        role="status"
        aria-live="polite"
      >
        {t(SAVE_LABEL[api.saveState])}
        {api.saveState === 'error' && (
          <button type="button" className="link-button" onClick={api.retrySave}>
            {t('common.retry')}
          </button>
        )}
      </span>

      {api.status === 'error' && (
        <span className="layout-save layout-save-error" role="alert">
          {t('layout.unavailable', { reason: api.loadError ?? '' })}
          <button type="button" className="link-button" onClick={api.reload}>
            {t('common.retry')}
          </button>
        </span>
      )}

      {api.notice !== null && (
        <div className="layout-notice" role="status" data-testid="layout-notice">
          <span>{api.notice}</span>
          <button type="button" className="link-button" onClick={api.dismissNotice}>
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {open && (
        <div className="layout-panel" id={panelId} role="dialog" aria-label={t('layout.panel')}>
          {mode.kind === 'list' && (
            <>
              <ul className="layout-list" aria-label={t('layout.list')}>
                {api.layouts.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className="layout-item"
                      aria-current={l.id === activeId ? 'true' : undefined}
                      disabled={busy}
                      onClick={() => void run(() => api.switchTo(l.id))}
                    >
                      {l.name}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="layout-actions" role="group" aria-label={t('layout.actions')}>
                <button type="button" onClick={() => startMode({ kind: 'new' })}>
                  {t('layout.new')}
                </button>
                <button
                  type="button"
                  disabled={activeId === null}
                  onClick={() => startMode({ kind: 'rename' }, activeName)}
                >
                  {t('layout.rename')}
                </button>
                <button
                  type="button"
                  disabled={activeId === null || busy}
                  onClick={() => activeId !== null && void run(() => api.duplicate(activeId))}
                >
                  {t('layout.duplicate')}
                </button>
                <button type="button" disabled={activeId === null} onClick={() => startMode({ kind: 'delete' })}>
                  {t('layout.delete')}
                </button>
              </div>
            </>
          )}
          {(mode.kind === 'new' || mode.kind === 'rename') &&
            nameForm(mode.kind === 'new' ? t('layout.newName') : t('layout.name'))}
          {mode.kind === 'delete' && (
            <div className="layout-confirm" role="alertdialog" aria-label={t('layout.confirmDelete')}>
              <p>{t('layout.deleteQuestion', { name: activeName })}</p>
              <div className="layout-form-actions">
                <button
                  type="button"
                  className="button layout-danger"
                  disabled={busy}
                  onClick={() => activeId !== null && void run(() => api.remove(activeId))}
                >
                  {t('layout.deleteSubmit')}
                </button>
                <button type="button" className="layout-plain" onClick={() => startMode({ kind: 'list' })}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
          {error !== null && (
            <p className="layout-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
