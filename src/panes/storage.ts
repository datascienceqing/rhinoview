import type { IndicatorConfig, IndicatorKind } from '@shared/types';
import { INDICATOR_KINDS, isHexColor, pickColor, sanitizeParams } from './config';

/** The slice of `Storage` we use, so tests can hand in a throwing or in-memory stand-in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VERSION = 1;
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
 * The indicators saved for `symbol`. Never throws: a missing, unreadable or corrupt
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

/** Best effort. Returns whether the write happened; a failure is never an error to the caller. */
export function saveIndicators(symbol: string, indicators: readonly IndicatorConfig[], storage?: StorageLike): boolean {
  try {
    (storage ?? defaultStorage()).setItem(storageKey(symbol), JSON.stringify({ version: VERSION, indicators }));
    return true;
  } catch {
    return false;
  }
}
