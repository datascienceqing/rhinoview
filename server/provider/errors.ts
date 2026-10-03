/**
 * Contract-level failures. Everything that can go wrong between the HTTP layer and
 * the engine is normalized to an `ApiFailure` here, so route handlers have exactly
 * one error shape to render and never see an engine's raw `Error`.
 *
 * Messages in this file are user-safe constants. Nothing derived from an engine or
 * upstream error is ever copied into `message` — the raw text goes to the log only,
 * after `redact()`.
 */
import type { ApiError, ApiErrorCode } from '@shared/types';
import { UnknownSymbolError } from '../market/types';

/** HTTP status for each contract error code (docs/CONTRACT.md, status mapping table). */
export const STATUS_FOR_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNKNOWN_SYMBOL: 404,
  NO_DATA: 404,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  UNAUTHORIZED: 500,
  INTERNAL: 500,
};

export class ApiFailure extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }

  get status(): number {
    return STATUS_FOR_CODE[this.code];
  }

  toApiError(): ApiError {
    const error: ApiError = { code: this.code, message: this.message };
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    return error;
  }
}

/**
 * Throwable by an engine (or fault injector) to signal upstream throttling. The
 * synthetic engine has no rate limit of its own; a real massive.com client will throw
 * this on a 429 carrying `Retry-After`.
 */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('Rate limited');
    this.name = 'RateLimitedError';
  }
}

/** Engine-side timeout (a future real client's fetch timeout). */
export class UpstreamTimeoutError extends Error {
  constructor() {
    super('Upstream timeout');
    this.name = 'UpstreamTimeoutError';
  }
}

/** Engine-side credential/plan failure (a future real client's upstream 401/403). */
export class UpstreamUnauthorizedError extends Error {
  constructor() {
    super('Upstream unauthorized');
    this.name = 'UpstreamUnauthorizedError';
  }
}

/**
 * Engine-side refusal of a well-formed request the provider cannot honour for a reason
 * that is not a plan tier, e.g. `adjusted=false` on a feed that only has the adjusted
 * series. Maps to BAD_REQUEST: retrying unchanged cannot succeed, and no upgrade fixes it.
 */
export class UnsupportedRequestError extends Error {
  constructor() {
    super('Unsupported request');
    this.name = 'UnsupportedRequestError';
  }
}

export const MESSAGES = {
  rateLimited: 'Rate limit reached. Retry after the indicated delay.',
  upstream: 'The market data provider failed to serve this request. Try again shortly.',
  timeout: 'The market data provider timed out. Try again shortly.',
  unauthorized: 'The proxy is not authorized to read this market data.',
  timeframeUnsupported: 'The active market data provider does not serve this timeframe.',
  unsupportedRequest: 'The active market data provider cannot serve this request as specified.',
  internal: 'Internal error.',
} as const;

/**
 * Map an error thrown by an *engine call* onto the contract. Anything unrecognized
 * becomes 502 UPSTREAM_ERROR: from the HTTP layer's point of view an engine that
 * throws is an upstream that failed. Bugs in our own route code never pass through
 * here — they hit the Fastify error handler and become 500 INTERNAL.
 */
export function mapEngineError(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  if (err instanceof UnknownSymbolError) {
    return new ApiFailure('UNKNOWN_SYMBOL', `Unknown symbol: ${err.symbol}`);
  }
  if (err instanceof RateLimitedError) {
    return new ApiFailure('RATE_LIMITED', MESSAGES.rateLimited, err.retryAfterSeconds);
  }
  if (err instanceof UpstreamTimeoutError) return new ApiFailure('UPSTREAM_TIMEOUT', MESSAGES.timeout);
  if (err instanceof UpstreamUnauthorizedError) return new ApiFailure('UNAUTHORIZED', MESSAGES.unauthorized);
  if (err instanceof UnsupportedRequestError) return new ApiFailure('BAD_REQUEST', MESSAGES.unsupportedRequest);
  return new ApiFailure('UPSTREAM_ERROR', MESSAGES.upstream);
}
