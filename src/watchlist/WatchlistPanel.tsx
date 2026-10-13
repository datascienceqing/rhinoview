import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent } from 'react';
import type { SearchResult, Snapshot, Watchlist } from '@shared/types';
import { MAX_NAME_LENGTH, MAX_QUOTE_SYMBOLS } from '@shared/types';
import { useSyntheticData } from '../data';
import { SymbolSearch } from '../ui/SymbolSearch';
import { useActiveChart } from '../workspace';
import { direction, fmtChange, fmtPercent, fmtPrice, fmtRange, fmtVolume, normKey } from './format';
import { moveItem, nextSort, sortSymbols } from './sort';
import type { SortKey, SortState } from './sort';
import { useQuotes } from './useQuotes';
import { useWatchlists } from './useWatchlists';
import './watchlist.css';
import { t as translate, useI18n } from '../i18n';

type Editor = 'none' | 'create' | 'rename' | 'delete';

/** `extra` columns collapse when the panel is narrow (see watchlist.css). */
/** Labels are `wl.col.<key>` and titles `wl.col.<key>.title` in the message catalogs. */
const COLUMNS: { key: SortKey; align: 'left' | 'right'; extra?: true }[] = [
  { key: 'symbol', align: 'left' },
  { key: 'price', align: 'right' },
  { key: 'change', align: 'right', extra: true },
  { key: 'changePercent', align: 'right' },
  { key: 'dayVolume', align: 'right', extra: true },
  { key: 'range', align: 'right', extra: true },
];

const ariaSort = (sort: SortState | null, key: SortKey): 'ascending' | 'descending' | 'none' =>
  sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

export function WatchlistPanel() {
  const { t } = useI18n();
  const { chart, setSymbol } = useActiveChart();
  const wl = useWatchlists();
  const active: Watchlist | undefined = wl.lists.find((w) => w.id === wl.activeId);
  const symbols = useMemo(() => active?.symbols ?? [], [active]);
  const q = useQuotes(symbols);

  const [sort, setSort] = useState<SortState | null>(null);
  const [editor, setEditor] = useState<Editor>('none');
  const [draft, setDraft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const focusSymbol = useRef<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // A different list is a different view: sorting is per view and never saved.
  useEffect(() => {
    setSort(null);
    setLocalNotice(null);
  }, [wl.activeId]);

  // Keep keyboard focus on the moved row's button after React reorders the DOM.
  useEffect(() => {
    const s = focusSymbol.current;
    if (!s) return;
    focusSymbol.current = null;
    focusRow(s);
  });

  const shown = useMemo(() => sortSymbols(symbols, q.quotes, sort), [symbols, q.quotes, sort]);
  const sorted = sort !== null;
  const synthetic = useSyntheticData();
  const atCap = symbols.length >= MAX_QUOTE_SYMBOLS;

  function openEditor(kind: Editor) {
    setEditor(kind);
    setDraft(kind === 'rename' ? (active?.name ?? '') : '');
    setFormError(null);
  }

  async function submitName(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      setFormError(t('wl.nameLength', { max: MAX_NAME_LENGTH }));
      return;
    }
    const done = editor === 'create' ? await wl.create(name) : active ? await wl.rename(active.id, name) : false;
    if (done) setEditor('none');
    else setFormError(t('wl.nameRefused'));
  }

  async function confirmDelete() {
    if (active && (await wl.remove(active.id))) setEditor('none');
  }

  function addSymbol(result: SearchResult) {
    if (!active) return;
    const symbol = result.symbol.toUpperCase();
    if (symbols.includes(symbol)) {
      setLocalNotice(t('wl.alreadyIn', { symbol }));
      return;
    }
    if (atCap) {
      setLocalNotice(t('wl.full', { max: MAX_QUOTE_SYMBOLS }));
      return;
    }
    setLocalNotice(null);
    wl.setSymbols(active.id, [...symbols, symbol]);
  }

  function removeSymbol(symbol: string) {
    if (active) wl.setSymbols(active.id, symbols.filter((s) => s !== symbol));
  }

  function reorder(from: number, to: number, focus?: string) {
    if (!active || sorted) return;
    const next = moveItem(symbols, from, to);
    if (next === symbols) return;
    if (focus) focusSymbol.current = focus;
    wl.setSymbols(active.id, next);
  }

  function focusRow(symbol: string) {
    const buttons = tableRef.current?.querySelectorAll<HTMLButtonElement>('button.wl-symbol') ?? [];
    for (const b of buttons) if (b.dataset.symbol === symbol) b.focus();
  }

  function onRowKey(e: KeyboardEvent<HTMLButtonElement>, symbol: string, index: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const step = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey) {
      reorder(index, index + step, symbol);
      return;
    }
    // Up and Down show the next symbol in the order on screen, like TradingView. No wrap.
    const next = shown[index + step];
    if (!next) return;
    setSymbol(next);
    focusRow(next);
  }

  function onDrop(e: DragEvent, target: string) {
    e.preventDefault();
    const from = dragging ? symbols.indexOf(dragging) : -1;
    setDragging(null);
    setDropTarget(null);
    if (from >= 0) reorder(from, symbols.indexOf(target));
  }

  return (
    <section className="watchlist-panel wl" data-testid="watchlist-panel" aria-label={t('wl.title')}>
      <header className="panel-header">
        <span>{t('wl.title')}</span>
        {synthetic && (
          <span className="wl-badge" data-testid="wl-synthetic-badge" title={t('wl.syntheticTitle')}>
            {t('wl.synthetic')}
          </span>
        )}
      </header>

      {wl.status === 'loading' && <p className="wl-note" role="status">{t('wl.loading')}</p>}
      {wl.status === 'error' && (
        <div className="wl-note" role="alert">
          {t('wl.loadFailed')}{' '}
          <button type="button" onClick={wl.reload}>{t('common.retry')}</button>
        </div>
      )}

      {wl.status === 'ready' && (
        <>
          <div className="wl-toolbar">
            <select
              aria-label={t('wl.select')}
              value={wl.activeId ?? ''}
              disabled={wl.lists.length === 0}
              onChange={(e) => wl.select(e.target.value)}
            >
              {wl.lists.length === 0 && <option value="">{t('wl.noLists')}</option>}
              {wl.lists.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <button type="button" onClick={() => openEditor('create')}>{t('wl.newList')}</button>
            <button type="button" disabled={!active} onClick={() => openEditor('rename')}>{t('wl.renameList')}</button>
            <button type="button" disabled={!active} onClick={() => openEditor('delete')}>{t('wl.deleteList')}</button>
          </div>

          {(editor === 'create' || editor === 'rename') && (
            <form className="wl-form" onSubmit={submitName}>
              <input
                aria-label={editor === 'create' ? t('wl.newListName') : t('wl.listName')}
                value={draft}
                maxLength={MAX_NAME_LENGTH}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setEditor('none')}
              />
              <button type="submit">{editor === 'create' ? t('wl.create') : t('wl.saveName')}</button>
              <button type="button" onClick={() => setEditor('none')}>{t('common.cancel')}</button>
              {formError && <p className="wl-error" role="alert">{formError}</p>}
            </form>
          )}
          {editor === 'delete' && active && (
            <div className="wl-form" role="alertdialog" aria-label={t('wl.confirmDelete')}>
              <p>{t('wl.deleteQuestion', { name: active.name })}</p>
              <button type="button" onClick={confirmDelete}>{t('wl.deleteNamed', { name: active.name })}</button>
              <button type="button" onClick={() => setEditor('none')}>{t('common.cancel')}</button>
            </div>
          )}

          {wl.notice && (
            <p className={wl.notice.kind === 'error' ? 'wl-error' : 'wl-note'} role="alert">
              {wl.notice.text} <button type="button" onClick={wl.dismissNotice}>{t('common.dismiss')}</button>
            </p>
          )}

          {active ? (
            <>
              <div className="wl-add">
                <SymbolSearch onSelect={addSymbol} label={t('wl.addLabel')} />
              </div>
              {localNotice && <p className="wl-note" role="status">{localNotice}</p>}

              {sorted ? (
                <p className="wl-note" id="wl-reorder-hint" role="status">
                  {t('wl.sortedHint')}{' '}
                  <button type="button" onClick={() => setSort(null)}>{t('wl.clearSort')}</button>
                </p>
              ) : (
                <p className="wl-hint" id="wl-reorder-hint">{t('wl.reorderHint')}</p>
              )}

              {q.error && (
                <p className="wl-error" role="alert">
                  {t('wl.quotesFailed', { reason: q.error })}{' '}
                  <button type="button" onClick={q.refresh}>{t('common.retry')}</button>
                </p>
              )}

              {symbols.length === 0 ? (
                <p className="wl-note">{t('wl.empty')}</p>
              ) : (
                <div className="wl-scroll">
                  <table className="wl-table" ref={tableRef}>
                    <thead>
                      <tr>
                        {COLUMNS.map((c) => (
                          <th key={c.key} scope="col" aria-sort={ariaSort(sort, c.key)} className={c.extra ? `${c.align} wl-extra` : c.align}>
                            <button
                              type="button"
                              title={t(`wl.col.${c.key}.title`)}
                              aria-label={t('wl.sortBy', { column: t(`wl.col.${c.key}.title`) })}
                              onClick={() => setSort((s) => nextSort(s, c.key))}
                            >
                              {t(`wl.col.${c.key}`)}
                              <span aria-hidden="true">{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                            </button>
                          </th>
                        ))}
                        <th scope="col"><span className="sr-only">{t('wl.removeHeader')}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((symbol, i) => (
                        <Row
                          key={symbol}
                          symbol={symbol}
                          index={i}
                          quote={q.quotes.get(normKey(symbol))}
                          missing={q.missing.has(normKey(symbol))}
                          failed={q.failed.has(normKey(symbol))}
                          unavailable={q.loaded}
                          isActive={chart.symbol.toUpperCase() === symbol.toUpperCase()}
                          canReorder={!sorted}
                          isDropTarget={dropTarget === symbol && dragging !== symbol}
                          onSelect={() => {
                            if (dragging) return;
                            setSymbol(symbol);
                            // A click on a cell (or a button in Safari) does not focus the
                            // row. Focus it, so Up and Down move through the list next.
                            focusRow(symbol);
                          }}
                          onRemove={() => removeSymbol(symbol)}
                          onKey={(e) => onRowKey(e, symbol, i)}
                          onDragStart={() => setDragging(symbol)}
                          onDragOver={(e) => {
                            if (dragging && !sorted) {
                              e.preventDefault();
                              setDropTarget(symbol);
                            }
                          }}
                          onDrop={(e) => onDrop(e, symbol)}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropTarget(null);
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="wl-note">{t('wl.none')}</p>
          )}
        </>
      )}
    </section>
  );
}

interface RowProps {
  symbol: string;
  index: number;
  quote: Snapshot | undefined;
  missing: boolean;
  failed: boolean;
  unavailable: boolean;
  isActive: boolean;
  canReorder: boolean;
  isDropTarget: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

/** Every value, for the row tooltip: the narrow layout hides some columns but never the data. */
function detail(q: Snapshot): string {
  return translate('wl.rowDetail', {
    symbol: q.symbol,
    last: fmtPrice(q.price),
    change: fmtChange(q.change),
    percent: fmtPercent(q.changePercent),
    volume: fmtVolume(q.dayVolume),
    range: fmtRange(q.dayLow, q.dayHigh),
  });
}

function Row(p: RowProps) {
  const { t } = useI18n();
  const { quote } = p;
  const dir = quote ? direction(quote.change) : 'flat';
  // Never blank, never zero: a symbol without a quote says why.
  const reason = p.missing ? 'missing' : p.failed || p.unavailable ? 'failed' : null;
  const cls = [p.isActive ? 'active' : '', p.isDropTarget ? 'drop' : '', p.canReorder ? 'movable' : ''].filter(Boolean).join(' ');
  return (
    <tr
      className={cls}
      data-symbol={p.symbol}
      aria-current={p.isActive ? 'true' : undefined}
      title={quote ? detail(quote) : undefined}
      draggable={p.canReorder}
      // A click anywhere on the row selects it. The symbol button stays the keyboard and
      // screen-reader target: its click bubbles here, so it needs no handler of its own.
      onClick={p.onSelect}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      onDragEnd={p.onDragEnd}
    >
      <th scope="row" className="left">
        <button
          type="button"
          className="wl-symbol"
          data-symbol={p.symbol}
          aria-describedby="wl-reorder-hint"
          aria-keyshortcuts={p.canReorder ? 'ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown' : 'ArrowUp ArrowDown'}
          title={t('wl.showOnChart', { symbol: p.symbol })}
          onKeyDown={p.onKey}
        >
          {p.symbol}
        </button>
      </th>
      {quote ? (
        <>
          <td className="right">{fmtPrice(quote.price)}</td>
          <td className={`right wl-extra ${dir}`}>{fmtChange(quote.change)}</td>
          <td className={`right ${dir}`}>{fmtPercent(quote.changePercent)}</td>
          <td className="right wl-extra">{fmtVolume(quote.dayVolume)}</td>
          <td className="right wl-extra">{fmtRange(quote.dayLow, quote.dayHigh)}</td>
        </>
      ) : (
        <td colSpan={5} className={`right wl-reason${reason ? ` ${reason}` : ''}`}>
          {reason === 'missing' ? t('wl.notFound') : reason === 'failed' ? t('wl.unavailable') : t('wl.rowLoading')}
        </td>
      )}
      <td className="right">
        <button type="button" className="wl-remove" aria-label={t('wl.removeSymbol', { symbol: p.symbol })} onClick={(e) => {
            e.stopPropagation();
            p.onRemove();
          }}
        >
          ×</button>
      </td>
    </tr>
  );
}
