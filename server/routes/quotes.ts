/**
 * `GET /api/quotes?symbols=AAPL,MSFT,...` — batch quotes for the watchlist.
 * See docs/CONTRACT.md (Phase 5) and `QuotesResponse` in shared/types.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { QuotesCache } from '../cache/quotesCache';
import { QuoteService, parseSymbolsParam } from '../provider/quotes';
import type { MarketService } from '../provider/service';
import { respond } from './envelope';

export interface QuotesRouteDeps {
  service: MarketService;
  /** Tests inject one; production gets a fresh cache shared by every request to this app. */
  cache?: QuotesCache;
  concurrency?: number;
}

export function registerQuotesRoutes(app: FastifyInstance, deps: QuotesRouteDeps): void {
  const quotes = new QuoteService({
    service: deps.service,
    ...(deps.cache ? { cache: deps.cache } : {}),
    ...(deps.concurrency ? { concurrency: deps.concurrency } : {}),
  });
  app.get('/api/quotes', (req, reply) =>
    respond(reply, () => quotes.getQuotes(parseSymbolsParam((req.query as { symbols?: unknown }).symbols))),
  );
}
