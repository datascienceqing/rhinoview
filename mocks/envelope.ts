/** Contract envelope helpers shared by every MSW handler module. */
import { HttpResponse } from 'msw';
import type { ApiError, ApiResult } from '@shared/types';

export const STATUS: Record<ApiError['code'], number> = {
  BAD_REQUEST: 400,
  UNKNOWN_SYMBOL: 404,
  NO_DATA: 200,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  UNAUTHORIZED: 500,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export function ok<T>(data: T, status = 200): Response {
  const body: ApiResult<T> = { ok: true, data };
  return HttpResponse.json(body, { status });
}

/** Contract-valid failure envelope with the status code the contract maps it to. */
export function fail(error: ApiError): Response {
  const body: ApiResult<never> = { ok: false, error };
  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds !== undefined) headers['Retry-After'] = String(error.retryAfterSeconds);
  return HttpResponse.json(body, { status: STATUS[error.code], headers });
}
