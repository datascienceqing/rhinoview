/**
 * `useCapabilities()` — what the server's providers can serve. Fetched once per page
 * load and shared by every caller: the timeframe selector disables what is not served,
 * and the shell hides the Financials toggle when there are no fundamentals.
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
