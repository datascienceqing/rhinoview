/**
 * Envelope helpers. Every response — success or failure — is an `ApiResult<T>`, and
 * the HTTP status mirrors it.
 */
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { ApiResult } from '@shared/types';
import { redact } from '../env';
import { ApiFailure, MESSAGES } from '../provider/errors';

export function failureResult(failure: ApiFailure): ApiResult<never> {
  return { ok: false, error: failure.toApiError() };
}

/** Log an unexpected error with the key scrubbed from message and stack alike. */
export function logUnexpected(log: FastifyBaseLogger, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error({ cause: redact(detail) }, 'unhandled error');
}

/** Send a failure envelope, with `Retry-After` when the failure carries one. */
export function sendFailure(reply: FastifyReply, failure: ApiFailure, status: number = failure.status): FastifyReply {
  if (failure.retryAfterSeconds !== undefined) {
    void reply.header('Retry-After', String(failure.retryAfterSeconds));
  }
  return reply.code(status).send(failureResult(failure));
}

/**
 * Run a handler body and render its outcome as an envelope. Anything that is not an
 * `ApiFailure` here is a bug in our own code (engine errors are already mapped by the
 * service), so it becomes 500 INTERNAL with a constant message — never the raw error.
 */
export async function respond<T>(reply: FastifyReply, body: () => Promise<T> | T): Promise<FastifyReply> {
  try {
    const data = await body();
    return reply.code(200).send({ ok: true, data } satisfies ApiResult<T>);
  } catch (err) {
    if (err instanceof ApiFailure) return sendFailure(reply, err);
    logUnexpected(reply.log, err);
    return sendFailure(reply, new ApiFailure('INTERNAL', MESSAGES.internal));
  }
}
