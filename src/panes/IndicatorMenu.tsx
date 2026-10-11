import { useEffect, useRef, useState } from 'react';
import type { IndicatorKind } from '@shared/types';
import type { IndicatorActions } from './hooks';
import type { ComputedIndicator } from './computeCache';
import { useI18n } from '../i18n';
import { INDICATOR_KINDS, indicatorTitle, kindLabel } from './config';
import { ParamsEditor } from './ParamsEditor';
import './panes.css';

export interface IndicatorMenuProps {
  items: readonly ComputedIndicator[];
  actions: Pick<IndicatorActions, 'add' | 'remove' | 'setParams' | 'setColor' | 'setVisible'>;
}

/** "Indicators" button and its panel: add any kind (several of one kind may coexist), then edit, hide or remove each. */
export function IndicatorMenu({ items, actions }: IndicatorMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="indicator-menu" ref={root}>
      <button
        type="button"
        className="indicator-menu-button"
        aria-expanded={open}
        aria-controls="indicator-panel"
        onClick={() => setOpen((o) => !o)}
      >
        {items.length > 0 ? t('indicator.menuCount', { count: items.length }) : t('indicator.menu')}
      </button>
      {open && (
        <div className="indicator-panel" id="indicator-panel" role="dialog" aria-label={t('indicator.menu')}>
          <div className="indicator-add" role="group" aria-label={t('indicator.add')}>
            {INDICATOR_KINDS.map((kind: IndicatorKind) => (
              <button type="button" key={kind} aria-label={t('indicator.addKind', { name: kindLabel(kind) })} onClick={() => actions.add(kind)}>
                + {kindLabel(kind)}
              </button>
            ))}
          </div>
          {items.length === 0 && <p className="indicator-empty">{t('indicator.empty')}</p>}
          <ul className="indicator-list">
            {items.map(({ config, error }) => {
              const title = indicatorTitle(config);
              return (
                <li key={config.id} className="indicator-item" data-testid={`indicator-item-${config.id}`}>
                  <div className="indicator-item-head">
                    <input
                      type="checkbox"
                      aria-label={t('indicator.show', { title })}
                      checked={config.visible}
                      onChange={(e) => actions.setVisible(config.id, e.target.checked)}
                    />
                    <input
                      type="color"
                      aria-label={t('indicator.colour', { title })}
                      value={config.color}
                      onChange={(e) => actions.setColor(config.id, e.target.value)}
                    />
                    <span className="indicator-item-title">{title}</span>
                    <button
                      type="button"
                      className="indicator-remove"
                      aria-label={t('indicator.remove', { title })}
                      onClick={() => actions.remove(config.id)}
                    >
                      ×
                    </button>
                  </div>
                  <ParamsEditor config={config} onChange={(params) => actions.setParams(config.id, params)} />
                  {error && (
                    <div className="param-error" role="alert">
                      {error}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
