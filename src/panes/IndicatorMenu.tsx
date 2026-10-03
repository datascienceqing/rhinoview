import { useEffect, useRef, useState } from 'react';
import type { IndicatorKind } from '@shared/types';
import type { IndicatorActions } from './hooks';
import type { ComputedIndicator } from './computeCache';
import { INDICATOR_KINDS, KIND_LABEL, indicatorTitle } from './config';
import { ParamsEditor } from './ParamsEditor';
import './panes.css';

export interface IndicatorMenuProps {
  items: readonly ComputedIndicator[];
  actions: Pick<IndicatorActions, 'add' | 'remove' | 'setParams' | 'setColor' | 'setVisible'>;
}

/** "Indicators" button and its panel: add any kind (several of one kind may coexist), then edit, hide or remove each. */
export function IndicatorMenu({ items, actions }: IndicatorMenuProps) {
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
        Indicators{items.length > 0 ? ` (${items.length})` : ''}
      </button>
      {open && (
        <div className="indicator-panel" id="indicator-panel" role="dialog" aria-label="Indicators">
          <div className="indicator-add" role="group" aria-label="Add indicator">
            {INDICATOR_KINDS.map((kind: IndicatorKind) => (
              <button type="button" key={kind} aria-label={`Add ${KIND_LABEL[kind]}`} onClick={() => actions.add(kind)}>
                + {KIND_LABEL[kind]}
              </button>
            ))}
          </div>
          {items.length === 0 && <p className="indicator-empty">No indicators. Add one above.</p>}
          <ul className="indicator-list">
            {items.map(({ config, error }) => {
              const title = indicatorTitle(config);
              return (
                <li key={config.id} className="indicator-item" data-testid={`indicator-item-${config.id}`}>
                  <div className="indicator-item-head">
                    <input
                      type="checkbox"
                      aria-label={`Show ${title}`}
                      checked={config.visible}
                      onChange={(e) => actions.setVisible(config.id, e.target.checked)}
                    />
                    <input
                      type="color"
                      aria-label={`Colour of ${title}`}
                      value={config.color}
                      onChange={(e) => actions.setColor(config.id, e.target.value)}
                    />
                    <span className="indicator-item-title">{title}</span>
                    <button
                      type="button"
                      className="indicator-remove"
                      aria-label={`Remove ${title}`}
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
