import type { ApiError, ApiErrorCode } from '@shared/types';

/**
 * Everything the UI can be asked to explain. The contract codes come from the proxy;
 * the three extras are failures that happen before a contract envelope exists:
 *
 * - `NETWORK`: fetch itself rejected (offline, DNS, connection refused).
 * - `BAD_RESPONSE`: something answered, but not with a contract envelope
 *   (a 200 with garbage, an HTML error page from a dev-server proxy).
 * - `ABORTED`: the caller cancelled, or a newer request superseded this one.
 *   Never user-visible; callers swallow it.
 */
export type DataErrorCode = ApiErrorCode | 'NETWORK' | 'BAD_RESPONSE' | 'ABORTED';

export const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'BAD_REQUEST',
  'UNKNOWN_SYMBOL',
  'NO_DATA',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'UNAUTHORIZED',
  'INTERNAL',
];

/**
 * Typed error thrown by every `DataSource` method. UI code branches on `code`,
 * never on `message` (the contract allows message wording to change freely).
 */
export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly retryAfterSeconds?: number;
  /** HTTP status when one was received; absent for network failures and aborts. */
  readonly status?: number;

  constructor(
    code: DataErrorCode,
    message: string,
    extra: { retryAfterSeconds?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'DataError';
    this.code = code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.status = extra.status;
  }

  static fromApiError(error: ApiError, status?: number): DataError {
    return new DataError(error.code, error.message, {
      retryAfterSeconds: error.retryAfterSeconds,
      status,
    });
  }
}

export function isDataError(e: unknown): e is DataError {
  return e instanceof DataError;
}

export function isAbortError(e: unknown): boolean {
  return isDataError(e) && e.code === 'ABORTED';
}

/** Coerce anything thrown into a DataError so UI code only handles one shape. */
export function toDataError(e: unknown): DataError {
  if (isDataError(e)) return e;
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new DataError('ABORTED', 'Request aborted', { cause: e });
  }
  const message = e instanceof Error ? e.message : 'Unexpected error';
  return new DataError('INTERNAL', message, { cause: e });
}
