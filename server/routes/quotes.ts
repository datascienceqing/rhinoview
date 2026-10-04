/**
 * `GET /api/quotes` — batch quotes for the watchlist. PHASE 5 STUB — Worker W1 implements.
 * See docs/CONTRACT.md and `QuotesResponse` in shared/types.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { MarketService } from '../provider/service';

export interface QuotesRouteDeps {
  service: MarketService;
}

export function registerQuotesRoutes(_app: FastifyInstance, _deps: QuotesRouteDeps): void {
  // W1: register GET /api/quotes here.
}
