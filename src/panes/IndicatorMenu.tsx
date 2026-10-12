import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { IndicatorKind } from '@shared/types';
import type { IndicatorActions } from './hooks';
import type { ComputedIndicator } from './computeCache';
import { useI18n } from '../i18n';
import { INDICATOR_KINDS, indicatorTitle, kindLabel } from './config';
import { ParamsEditor } from './ParamsEditor';
import './panes.css';

export interface IndicatorMenuProps {
  items: readonly ComputedIndicator[];
  actions: Pick<IndicatorActions, 'add' | 'remove' | 'setParams' | 'setColor' | 'setVisible' | 'move'>;
}

/** Which control of a moved row keeps the keyboard focus after React reorders the list. */
type FocusTarget = { id: string; control: 'grip' | 'up' | 'down' };

/**
 * "Indicators" button and its panel: add any kind (several of one kind may coexist), then
 * edit, hide, remove or reorder each. The list order is the order of the indicator panes
 * from the top: drag a row by its grip, press Alt+Up or Alt+Down on the grip, or use the
 * arrow buttons, as in the watchlist.
 */
export function IndicatorMenu({ items, actions }: IndicatorMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const focusAfterMove = useRef<FocusTarget | null>(null);

  // Keep keyboard focus on the moved row after React reorders the DOM. At the top or the
  // bottom an arrow button is disabled, so the focus goes to the grip of that row.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const row = root.current?.querySelector(`[data-testid="indicator-item-${CSS.escape(target.id)}"]`);
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-control="${target.control}"]`);
    (wanted && !wanted.disabled ? wanted : row?.querySelector<HTMLButtonElement>('[data-control="grip"]'))?.focus();
  });

  function move(id: string, to: number, control?: FocusTarget['control']) {
    if (control) focusAfterMove.current = { id, control };
    actions.move(id, to);
  }

  function onGripKey(e: ReactKeyboardEvent<HTMLButtonElement>, id: string, index: number) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(id, index + (e.key === 'ArrowUp' ? -1 : 1), 'grip');
  }

  function onDrop(e: ReactDragEvent, target: number) {
    e.preventDefault();
    const id = dragging;
    setDragging(null);
    setDropTarget(null);
    if (id) move(id, target);
  }

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
          {items.length > 1 && (
            <p className="indicator-hint" id="indicator-reorder-hint">
              {t('indicator.reorderHint')}
            </p>
          )}
          <ul className="indicator-list">
            {items.map(({ config, error }, index) => {
              const title = indicatorTitle(config);
              const cls = ['indicator-item', dropTarget === config.id && dragging !== config.id ? 'drop' : ''].filter(Boolean).join(' ');
              return (
                <li
                  key={config.id}
                  className={cls}
                  data-testid={`indicator-item-${config.id}`}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    setDropTarget(config.id);
                  }}
                  onDrop={(e) => onDrop(e, index)}
                >
                  <div className="indicator-item-head">
                    {items.length > 1 && (
                      <button
                        type="button"
                        className="indicator-grip"
                        data-control="grip"
                        draggable
                        aria-label={t('indicator.reorder', { title })}
                        aria-describedby="indicator-reorder-hint"
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        onKeyDown={(e) => onGripKey(e, config.id, index)}
                        onDragStart={(e) => {
                          e.dataTransfer?.setData('text/plain', config.id);
                          setDragging(config.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                      >
                        ⠿
                      </button>
                    )}
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
                    {items.length > 1 && (
                      <>
                        <button
                          type="button"
                          className="indicator-order"
                          data-control="up"
                          aria-label={t('indicator.moveUp', { title })}
                          disabled={index === 0}
                          onClick={() => move(config.id, index - 1, 'up')}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="indicator-order"
                          data-control="down"
                          aria-label={t('indicator.moveDown', { title })}
                          disabled={index === items.length - 1}
                          onClick={() => move(config.id, index + 1, 'down')}
                        >
                          ▼
                        </button>
                      </>
                    )}
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
