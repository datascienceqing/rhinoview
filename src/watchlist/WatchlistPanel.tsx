import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent } from 'react';
import type { SearchResult, Snapshot, Watchlist } from '@shared/types';
import { MAX_NAME_LENGTH, MAX_QUOTE_SYMBOLS } from '@shared/types';
import { SymbolSearch } from '../ui/SymbolSearch';
import { useActiveChart } from '../workspace';
import { direction, fmtChange, fmtPercent, fmtPrice, fmtRange, fmtVolume } from './format';
import { moveItem, nextSort, sortSymbols } from './sort';
import type { SortKey, SortState } from './sort';
import { useQuotes } from './useQuotes';
import { useWatchlists } from './useWatchlists';
import './watchlist.css';

type Editor = 'none' | 'create' | 'rename' | 'delete';

/** `extra` columns collapse when the panel is narrow (see watchlist.css). */
const COLUMNS: { key: SortKey; label: string; title: string; align: 'left' | 'right'; extra?: true }[] = [
  { key: 'symbol', label: 'Symbol', title: 'Symbol', align: 'left' },
  { key: 'price', label: 'Last', title: 'Last price', align: 'right' },
  { key: 'change', label: 'Chg', title: 'Change', align: 'right', extra: true },
  { key: 'changePercent', label: 'Chg %', title: 'Change percent', align: 'right' },
  { key: 'dayVolume', label: 'Vol', title: 'Volume', align: 'right', extra: true },
  { key: 'range', label: 'Day range', title: 'Day range (sorts by width)', align: 'right', extra: true },
];

const ariaSort = (sort: SortState | null, key: SortKey): 'ascending' | 'descending' | 'none' =>
  sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

export function WatchlistPanel() {
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
    const buttons = tableRef.current?.querySelectorAll<HTMLButtonElement>('button.wl-symbol') ?? [];
    for (const b of buttons) if (b.dataset.symbol === s) b.focus();
  });

  const shown = useMemo(() => sortSymbols(symbols, q.quotes, sort), [symbols, q.quotes, sort]);
  const sorted = sort !== null;
  const delayed = [...q.quotes.values()].some((s) => s.delayed);
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
      setFormError(`Enter a name of 1 to ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    const done = editor === 'create' ? await wl.create(name) : active ? await wl.rename(active.id, name) : false;
    if (done) setEditor('none');
    else setFormError('The name was not accepted. Read the message below.');
  }

  async function confirmDelete() {
    if (active && (await wl.remove(active.id))) setEditor('none');
  }

  function addSymbol(result: SearchResult) {
    if (!active) return;
    const symbol = result.symbol.toUpperCase();
    if (symbols.includes(symbol)) {
      setLocalNotice(`${symbol} is already in this list.`);
      return;
    }
    if (atCap) {
      setLocalNotice(`A list holds at most ${MAX_QUOTE_SYMBOLS} symbols.`);
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

  function onRowKey(e: KeyboardEvent<HTMLButtonElement>, symbol: string, index: number) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    reorder(index, index + (e.key === 'ArrowUp' ? -1 : 1), symbol);
  }

  function onDrop(e: DragEvent, target: string) {
    e.preventDefault();
    const from = dragging ? symbols.indexOf(dragging) : -1;
    setDragging(null);
    setDropTarget(null);
    if (from >= 0) reorder(from, symbols.indexOf(target));
  }

  return (
    <section className="watchlist-panel wl" data-testid="watchlist-panel" aria-label="Watchlist">
      <header className="panel-header">
        <span>Watchlist</span>
        {delayed && (
          <span className="wl-badge" title="Quotes are delayed, not live.">
            Delayed
          </span>
        )}
      </header>

      {wl.status === 'loading' && <p className="wl-note" role="status">Loading watchlists…</p>}
      {wl.status === 'error' && (
        <div className="wl-note" role="alert">
          Could not load the watchlists.{' '}
          <button type="button" onClick={wl.reload}>Retry</button>
        </div>
      )}

      {wl.status === 'ready' && (
        <>
          <div className="wl-toolbar">
            <select
              aria-label="Watchlist"
              value={wl.activeId ?? ''}
              disabled={wl.lists.length === 0}
              onChange={(e) => wl.select(e.target.value)}
            >
              {wl.lists.length === 0 && <option value="">No lists</option>}
              {wl.lists.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <button type="button" onClick={() => openEditor('create')}>New list</button>
            <button type="button" disabled={!active} onClick={() => openEditor('rename')}>Rename list</button>
            <button type="button" disabled={!active} onClick={() => openEditor('delete')}>Delete list</button>
          </div>

          {(editor === 'create' || editor === 'rename') && (
            <form className="wl-form" onSubmit={submitName}>
              <input
                aria-label={editor === 'create' ? 'New list name' : 'List name'}
                value={draft}
                maxLength={MAX_NAME_LENGTH}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setEditor('none')}
              />
              <button type="submit">{editor === 'create' ? 'Create' : 'Save name'}</button>
              <button type="button" onClick={() => setEditor('none')}>Cancel</button>
              {formError && <p className="wl-error" role="alert">{formError}</p>}
            </form>
          )}
          {editor === 'delete' && active && (
            <div className="wl-form" role="alertdialog" aria-label="Confirm delete">
              <p>Delete the list “{active.name}”? This cannot be undone.</p>
              <button type="button" onClick={confirmDelete}>Delete “{active.name}”</button>
              <button type="button" onClick={() => setEditor('none')}>Cancel</button>
            </div>
          )}

          {wl.notice && (
            <p className={wl.notice.kind === 'error' ? 'wl-error' : 'wl-note'} role="alert">
              {wl.notice.text} <button type="button" onClick={wl.dismissNotice}>Dismiss</button>
            </p>
          )}

          {active ? (
            <>
              <div className="wl-add">
                <SymbolSearch onSelect={addSymbol} label="Add symbol to watchlist" />
              </div>
              {localNotice && <p className="wl-note" role="status">{localNotice}</p>}

              {sorted ? (
                <p className="wl-note" id="wl-reorder-hint" role="status">
                  Reorder is off while the list is sorted. Clear the sort to drag or move rows.{' '}
                  <button type="button" onClick={() => setSort(null)}>Clear sort</button>
                </p>
              ) : (
                <p className="wl-hint" id="wl-reorder-hint">Drag a row, or press Alt+Up or Alt+Down on a symbol, to reorder.</p>
              )}

              {q.error && (
                <p className="wl-error" role="alert">
                  Quotes did not refresh. {q.error}{' '}
                  <button type="button" onClick={q.refresh}>Retry</button>
                </p>
              )}

              {symbols.length === 0 ? (
                <p className="wl-note">This list is empty. Search for a symbol to add it.</p>
              ) : (
                <div className="wl-scroll">
                  <table className="wl-table" ref={tableRef}>
                    <thead>
                      <tr>
                        {COLUMNS.map((c) => (
                          <th key={c.key} scope="col" aria-sort={ariaSort(sort, c.key)} className={c.extra ? `${c.align} wl-extra` : c.align}>
                            <button
                              type="button"
                              title={c.title}
                              aria-label={`Sort by ${c.title.toLowerCase()}`}
                              onClick={() => setSort((s) => nextSort(s, c.key))}
                            >
                              {c.label}
                              <span aria-hidden="true">{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                            </button>
                          </th>
                        ))}
                        <th scope="col"><span className="sr-only">Remove</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((symbol, i) => (
                        <Row
                          key={symbol}
                          symbol={symbol}
                          index={i}
                          quote={q.quotes.get(symbol.toUpperCase())}
                          missing={q.missing.has(symbol.toUpperCase())}
                          failed={q.failed.has(symbol.toUpperCase())}
                          unavailable={q.error !== null && q.quotes.size === 0}
                          isActive={chart.symbol.toUpperCase() === symbol.toUpperCase()}
                          canReorder={!sorted}
                          isDropTarget={dropTarget === symbol && dragging !== symbol}
                          onSelect={() => setSymbol(symbol)}
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
            <p className="wl-note">There are no watchlists. Choose New list to make one.</p>
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
  return `${q.symbol}: last ${fmtPrice(q.price)}, change ${fmtChange(q.change)} (${fmtPercent(q.changePercent)}), volume ${fmtVolume(q.dayVolume)}, day range ${fmtRange(q.dayLow, q.dayHigh)}`;
}

function Row(p: RowProps) {
  const { quote } = p;
  const dir = quote ? direction(quote.change) : 'flat';
  // Never blank, never zero: a symbol without a quote says why.
  const reason = p.missing ? 'not found' : p.failed || p.unavailable ? 'unavailable' : null;
  const cls = [p.isActive ? 'active' : '', p.isDropTarget ? 'drop' : '', p.canReorder ? 'movable' : ''].filter(Boolean).join(' ');
  return (
    <tr
      className={cls}
      data-symbol={p.symbol}
      aria-current={p.isActive ? 'true' : undefined}
      title={quote ? detail(quote) : undefined}
      draggable={p.canReorder}
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
          aria-keyshortcuts={p.canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          title={`Show ${p.symbol} on the chart`}
          onClick={p.onSelect}
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
        <td colSpan={5} className={`right wl-reason${reason ? ` ${reason === 'not found' ? 'missing' : 'failed'}` : ''}`}>
          {reason ?? 'loading…'}
        </td>
      )}
      <td className="right">
        <button type="button" className="wl-remove" aria-label={`Remove ${p.symbol}`} onClick={p.onRemove}>×</button>
      </td>
    </tr>
  );
}
