import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SearchResult } from '@shared/types';
import { useAsync, useDataSource } from '../data';
import { useI18n } from '../i18n';
import { describeError } from './errorCopy';
import { useDebouncedValue } from './useDebouncedValue';

export const SEARCH_DEBOUNCE_MS = 250;

export interface SymbolSearchProps {
  onSelect: (result: SearchResult) => void;
  debounceMs?: number;
  /** Accessible name. Give each instance on one page its own name, so they can be told apart. */
  label?: string;
}

export function SymbolSearch({ onSelect, debounceMs = SEARCH_DEBOUNCE_MS, label: labelProp }: SymbolSearchProps) {
  const { t } = useI18n();
  const label = labelProp ?? t('search.label');
  const ds = useDataSource();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, debounceMs);
  const search = useAsync(debounced === '' ? null : debounced, (signal) =>
    ds.searchSymbols(debounced, { signal }),
  );

  // Results shown must belong to what the user has typed; while the debounce is
  // pending (or a request is in flight) we show "Searching…" rather than stale rows.
  const pending = trimmed !== debounced || search.status === 'loading';
  const results = !pending && search.status === 'success' ? search.data.results : [];

  useEffect(() => {
    setActive(-1);
  }, [debounced]);

  useEffect(() => {
    // jsdom has no scrollIntoView.
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);

  function select(result: SearchResult) {
    onSelect(result);
    setQuery('');
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        if (results.length === 0) return;
        e.preventDefault();
        setOpen(true);
        setActive((i) => (i + 1) % results.length);
        break;
      case 'ArrowUp':
        if (results.length === 0) return;
        e.preventDefault();
        setOpen(true);
        setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
        break;
      case 'Enter': {
        // With nothing highlighted, Enter takes the top result, like most symbol boxes.
        const choice = results[active >= 0 ? active : 0];
        if (open && choice) {
          e.preventDefault();
          select(choice);
        }
        break;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
          setActive(-1);
        }
        break;
    }
  }

  const showPanel = open && trimmed !== '';
  const activeId = active >= 0 && results[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <div
      className="symbol-search"
      ref={rootRef}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-activedescendant={activeId}
        placeholder={t('search.placeholder')}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showPanel && (
        <div className="search-panel" id={listId}>
          {pending ? (
            <div className="search-note" role="status">
              {t('search.searching')}
            </div>
          ) : search.status === 'error' ? (
            <SearchError error={search.error} onRetry={search.reload} />
          ) : results.length === 0 ? (
            <div className="search-note" role="status">
              {t('search.noMatch', { query: debounced })}
            </div>
          ) : (
            <ul role="listbox" aria-label={t('search.results', { label })}>
              {results.map((r, i) => (
                <li
                  key={r.symbol}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'search-option active' : 'search-option'}
                  // mousedown (not click) so the input doesn't blur and close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(r);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="opt-symbol">{r.symbol}</span>
                  <span className="opt-name">{r.name}</span>
                  <span className="opt-exchange">{r.exchange ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SearchError({ error, onRetry }: { error: Parameters<typeof describeError>[0]; onRetry: () => void }) {
  const { t } = useI18n();
  const copy = describeError(error, 'search');
  return (
    <div className="search-note search-error" role="alert">
      <strong>{copy.title}.</strong> {copy.detail}
      {copy.retryable && (
        <button type="button" className="link-button" onMouseDown={(e) => e.preventDefault()} onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
