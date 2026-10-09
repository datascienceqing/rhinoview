import type { IndicatorConfig, IndicatorKind } from '@shared/types';
import { INDICATOR_KINDS, isHexColor, pickColor, sanitizeParams } from './config';

/** The slice of `Storage` we read, so tests can hand in a throwing or in-memory stand-in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the one-time cleanup needs on top of StorageLike: enumerating and removing keys. */
export interface EnumerableStorageLike extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/**
 * Phase 5 retired per-symbol indicator persistence: indicators now live in the active
 * layout on the server. This file only reads the old entries so they can be migrated
 * once, then deletes them. Nothing here writes indicators any more.
 */
export const MIGRATED_FLAG_KEY = 'rhinoview:indicators-migrated';

const KEY_PREFIX = 'charting-app:indicators:';

export function storageKey(symbol: string): string {
  return `${KEY_PREFIX}${symbol}`;
}

/**
 * `window.localStorage` itself can throw on access (SecurityError with blocked site
 * data), so even resolving it is inside the try/catch of every caller.
 */
function defaultStorage(): StorageLike {
  return globalThis.localStorage;
}

function isKind(value: unknown): value is IndicatorKind {
  return INDICATOR_KINDS.some((k) => k === value);
}

/**
 * One persisted entry -> a trustworthy config, or null to drop it. Anything stored is
 * untrusted: it may be hand-edited, from an older shape, or truncated.
 */
function restore(raw: unknown, accepted: readonly IndicatorConfig[], seen: Set<string>): IndicatorConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const { id, kind } = rec;
  if (typeof id !== 'string' || id === '' || seen.has(id) || !isKind(kind)) return null;
  const params = sanitizeParams(kind, rec['params']);
  if (!params) return null;
  return {
    id,
    kind,
    params,
    color: isHexColor(rec['color']) ? rec['color'] : pickColor(accepted),
    visible: typeof rec['visible'] === 'boolean' ? rec['visible'] : true,
  };
}

/**
 * The legacy indicators saved for `symbol`. Never throws: a missing, unreadable or corrupt
 * entry yields `[]` so the chart renders with defaults. Individually bad entries are
 * dropped while the good ones survive.
 */
export function loadIndicators(symbol: string, storage?: StorageLike): IndicatorConfig[] {
  try {
    const raw = (storage ?? defaultStorage()).getItem(storageKey(symbol));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const list = (parsed as Record<string, unknown>)['indicators'];
    if (!Array.isArray(list)) return [];
    const out: IndicatorConfig[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const config = restore(entry, out, seen);
      if (!config) continue;
      seen.add(config.id);
      out.push(config);
    }
    return out;
  } catch {
    return [];
  }
}

/** Whether the one-time migration already ran. An unreadable store counts as not migrated. */
export function isMigrated(storage?: StorageLike): boolean {
  try {
    return (storage ?? defaultStorage()).getItem(MIGRATED_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remove every `charting-app:indicators:*` key and set the migrated flag. Each step is
 * guarded on its own, so a store that throws on one call still gets the others tried.
 */
export function retireLegacyIndicators(storage?: EnumerableStorageLike): void {
  let store: EnumerableStorageLike;
  try {
    store = storage ?? (globalThis.localStorage as EnumerableStorageLike);
  } catch {
    return;
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k !== null && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      try {
        store.removeItem(k);
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* enumeration failed; the flag below still stops a second migration */
  }
  try {
    store.setItem(MIGRATED_FLAG_KEY, '1');
  } catch {
    /* best effort */
  }
}
