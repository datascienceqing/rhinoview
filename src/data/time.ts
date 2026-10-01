import type { UnixSeconds } from '@shared/types';

/**
 * Current wall-clock time in Unix SECONDS.
 *
 * The one place the browser clock (`Date.now()`, milliseconds) enters the
 * seconds-everywhere contract. It exists only to anchor the "last N days" request
 * window; no Bar.time is ever converted anywhere in the client.
 */
export function nowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000);
}
