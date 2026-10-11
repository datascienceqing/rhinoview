/**
 * `useCapabilities()` — what the server's providers can serve. Fetched once per page
 * load and shared by every caller: the timeframe selector disables what is not served,
 * and the shell hides the Financials toggle when there are no fundamentals.
 *
 * `useSyntheticData()` tells the badges whether the data is synthetic.
 */
import { useEffect, useState } from 'react';
import type { Capabilities } from '@shared/types';
import { apiRequest } from './request';

let pending: Promise<Capabilities> | null = null;

/** Test hook: forget the cached result so the next call fetches again. */
export function resetCapabilitiesCache(): void {
  pending = null;
}

export function fetchCapabilities(): Promise<Capabilities> {
  pending ??= apiRequest<Capabilities>('/capabilities').catch((e: unknown) => {
    pending = null; // a failure is not cached; the next caller tries again
    throw e;
  });
  return pending;
}

/** Null until known. Callers treat null as: every timeframe enabled, no fundamentals. */
export function useCapabilities(): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    let live = true;
    fetchCapabilities().then(
      (c) => live && setCaps(c),
      () => undefined, // the app still works without capabilities; it just cannot pre-disable
    );
    return () => {
      live = false;
    };
  }, []);
  return caps;
}

/**
 * Providers whose data is synthetic: the server's generated data, and the client's MSW
 * mocks (built from synthetic fixtures). The header and the watchlist badge it, so that
 * nobody takes it for a market price. Real data has no badge, delayed or not.
 */
export const SYNTHETIC_PROVIDERS: ReadonlySet<string> = new Set(['synthetic', 'mock']);

export function isSyntheticData(caps: Pick<Capabilities, 'provider'> | null): boolean {
  return caps !== null && SYNTHETIC_PROVIDERS.has(caps.provider);
}

/** False until the capabilities are known, so a badge never flashes on real data. */
export function useSyntheticData(): boolean {
  return isSyntheticData(useCapabilities());
}
