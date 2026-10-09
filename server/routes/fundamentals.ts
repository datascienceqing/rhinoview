/**
 * `GET /api/fundamentals/{overview,statements,earnings}`.
 * See docs/CONTRACT.md (Phase 5) and server/fundamentals/types.ts.
 *
 * Handlers: zod-parse the query, call the provider, render the envelope. Provider errors
 * go through `mapEngineError` like the market routes: an unknown symbol is 404
 * UNKNOWN_SYMBOL, a plan-tier failure is UNAUTHORIZED, throttling is RATE_LIMITED, and
 * anything unrecognised (including a bad upstream shape) is a constant-message
 * UPSTREAM_ERROR. The raw error goes to the log only, with the key redacted.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_EARNINGS_LIMIT, MAX_EARNINGS_LIMIT } from '@shared/types';
import { redact } from '../env';
import type { FundamentalsProvider } from '../fundamentals/types';
import { UnknownSymbolError } from '../market/types';
import { mapEngineError } from '../provider/errors';
import { respond } from './envelope';
import { parseQuery } from './schemas';

export interface FundamentalsRouteDeps {
  fundamentals: FundamentalsProvider;
}

// MUST match SYMBOL_RE in server/workspace/store.ts: any symbol a layout can hold (index
// symbols such as "^GSPC" included) must be accepted here, or the Financials drawer and the
// earnings markers fail with BAD_REQUEST for a chart the workspace allows. A symbol that
// passes but has no fundamentals answers UNKNOWN_SYMBOL from the provider.
const symbol = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.^=-]{1,16}$/, 'must be 1-16 characters: letters, digits, ".", "^", "=" or "-"');

const enumOf = <const T extends string>(values: readonly [T, ...T[]]) =>
  z.enum(values, { errorMap: () => ({ message: `must be one of ${values.join(', ')}` }) });

export const overviewQuery = z.object({ symbol });
// Strict integer string: `z.coerce.number()` would take "" as 0 and "1e2" as 100.
const earningsLimit = z
  .string()
  .regex(/^\d{1,4}$/, 'must be an integer')
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_EARNINGS_LIMIT, `must be at most ${MAX_EARNINGS_LIMIT}`))
  .default(String(DEFAULT_EARNINGS_LIMIT));
export const earningsQuery = z.object({ symbol, limit: earningsLimit });
export const statementsQuery = z.object({
  symbol,
  statement: enumOf(['income', 'balance', 'cashflow']),
  period: enumOf(['annual', 'quarter']),
});

export function registerFundamentalsRoutes(app: FastifyInstance, deps: FundamentalsRouteDeps): void {
  const { fundamentals } = deps;

  /**
   * Parse the query (BAD_REQUEST on failure), call the provider, and map whatever it
   * throws. Parsing happens before the provider is touched, so a bad request costs no
   * upstream call.
   */
  const serve = <S extends z.ZodTypeAny, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    call: (query: z.output<S>) => Promise<T>,
  ) =>
    respond(reply, async () => {
      const query = parseQuery(schema, req.query);
      try {
        return await call(query);
      } catch (err) {
        if (!(err instanceof UnknownSymbolError)) {
          const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          req.log.warn({ cause: redact(detail) }, 'fundamentals provider failed');
        }
        throw mapEngineError(err);
      }
    });

  app.get('/api/fundamentals/overview', (req, reply) =>
    serve(req, reply, overviewQuery, (q) => fundamentals.getOverview(q.symbol)),
  );

  app.get('/api/fundamentals/statements', (req, reply) =>
    serve(req, reply, statementsQuery, (q) => fundamentals.getStatements(q.symbol, q.statement, q.period)),
  );

  app.get('/api/fundamentals/earnings', (req, reply) =>
    // The provider (and the cache in front of it) holds the FULL list; the route cuts it, so
    // a larger `limit` costs no extra upstream call. Events are newest first.
    serve(req, reply, earningsQuery, async (q) => {
      const res = await fundamentals.getEarnings(q.symbol);
      return { ...res, events: res.events.slice(0, q.limit) };
    }),
  );
}
