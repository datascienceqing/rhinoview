/**
 * HTTP route registration for the contract endpoints.
 *
 * Handlers are intentionally trivial: zod-parse the query, call the service, render
 * the envelope. Everything with logic lives in `server/provider/`.
 */
import type { FastifyInstance } from 'fastify';
import type { MarketService } from '../provider/service';
import { ApiFailure, MESSAGES } from '../provider/errors';
import { logUnexpected, respond, sendFailure } from './envelope';
import { barsQuery, indicatorQuery, parseQuery, searchQuery, snapshotQuery } from './schemas';

export function registerApiRoutes(app: FastifyInstance, service: MarketService): void {
  // Anything that escapes a handler or Fastify itself still leaves as an envelope, and
  // never as Fastify's default JSON (which can carry the raw error message).
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendFailure(reply, new ApiFailure('BAD_REQUEST', 'Malformed request.'));
    }
    logUnexpected(req.log, err);
    return sendFailure(reply, new ApiFailure('INTERNAL', MESSAGES.internal));
  });

  // There is no NOT_FOUND code in the contract; an unknown path is a caller error.
  app.setNotFoundHandler((_req, reply) =>
    sendFailure(reply, new ApiFailure('BAD_REQUEST', 'No such endpoint.'), 404),
  );

  app.get('/api/capabilities', (_req, reply) => respond(reply, () => service.capabilities()));

  app.get('/api/search', (req, reply) =>
    respond(reply, () => {
      const { q, limit } = parseQuery(searchQuery, req.query);
      return service.search(q, limit);
    }),
  );

  app.get('/api/bars', (req, reply) =>
    respond(reply, () => service.bars(parseQuery(barsQuery, req.query))),
  );

  app.get('/api/snapshot', (req, reply) =>
    respond(reply, () => service.snapshot(parseQuery(snapshotQuery, req.query).symbol)),
  );

  // ORACLE / DEBUG ONLY. Application code must NOT call this endpoint: runtime
  // indicators are computed client-side in `src/indicators/` from bars already in
  // hand (no quota per indicator, instant recompute on parameter change, works while
  // panning cached bars). It exists so unit tests can compare local indicator math
  // against an independent implementation. With the synthetic engine there is no
  // upstream oracle, so the answer is computed server-side from the same engine
  // bars the client sees — a consistency check, not independent ground truth.
  app.get('/api/indicator', (req, reply) =>
    respond(reply, () => service.indicator(parseQuery(indicatorQuery, req.query))),
  );
}
