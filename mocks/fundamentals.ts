/**
 * MSW mock of `/api/fundamentals/*`, built from the FMP fixtures (AAPL, MSFT,
 * JPM, TSM, RIVN: real shapes, synthetic values) so the panel sees nulls, fiscal labels,
 * currencies. The mapping lives in ./fundamentalsData.ts and is the only part the
 * orchestrator swaps for the real server mapper at integration.
 */
import { http } from 'msw';
import type { StatementKind, StatementPeriod } from '@shared/types';
import { DEFAULT_EARNINGS_LIMIT, MAX_EARNINGS_LIMIT } from '@shared/types';
import { fail, ok } from './envelope';
import { earningsFor, hasFundamentals, newsFor, overviewFor, statementsFor } from './fundamentalsData';

const badRequest = (message: string) => fail({ code: 'BAD_REQUEST', message });

type SymbolResult = { symbol: string } | { response: Response };

function resolveSymbol(url: URL): SymbolResult {
  const raw = url.searchParams.get('symbol') ?? '';
  if (raw.length < 1 || raw.length > 16) return { response: badRequest('symbol must be 1-16 characters.') };
  const symbol = raw.toUpperCase();
  if (!hasFundamentals(symbol)) {
    return { response: fail({ code: 'UNKNOWN_SYMBOL', message: `No data found for symbol "${raw}".` }) };
  }
  return { symbol };
}

/** Contract rule: absent -> default; otherwise ONE value that is an integer in 1..MAX. Else null. */
function parseEarningsLimit(url: URL): number | null {
  const all = url.searchParams.getAll('limit');
  if (all.length === 0) return DEFAULT_EARNINGS_LIMIT;
  const raw = all[0] ?? '';
  if (all.length > 1 || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_EARNINGS_LIMIT ? n : null;
}

export function createFundamentalsHandlers() {
  return [
    http.get('*/api/fundamentals/overview', ({ request }) => {
      const r = resolveSymbol(new URL(request.url));
      return 'response' in r ? r.response : ok(overviewFor(r.symbol));
    }),

    http.get('*/api/fundamentals/statements', ({ request }) => {
      const url = new URL(request.url);
      const statement = url.searchParams.get('statement');
      const period = url.searchParams.get('period');
      // Params are validated before the symbol lookup, as a schema layer would.
      if (statement !== 'income' && statement !== 'balance' && statement !== 'cashflow') {
        return badRequest('statement must be one of income, balance, cashflow.');
      }
      if (period !== 'annual' && period !== 'quarter') return badRequest('period must be annual or quarter.');
      const r = resolveSymbol(url);
      if ('response' in r) return r.response;
      return ok(statementsFor(r.symbol, statement as StatementKind, period as StatementPeriod));
    }),

    http.get('*/api/fundamentals/earnings', ({ request }) => {
      const url = new URL(request.url);
      const limit = parseEarningsLimit(url);
      if (limit === null) return badRequest(`limit must be an integer from 1 to ${MAX_EARNINGS_LIMIT}.`);
      const r = resolveSymbol(url);
      if ('response' in r) return r.response;
      // Newest first, so the newest `limit` events are a prefix.
      const full = earningsFor(r.symbol);
      return ok({ ...full, events: full.events.slice(0, limit) });
    }),

    http.get('*/api/fundamentals/news', ({ request }) => {
      const r = resolveSymbol(new URL(request.url));
      return 'response' in r ? r.response : ok(newsFor(r.symbol));
    }),
  ];
}
