/**
 * Data for the fundamentals mock: the REAL server mapping (server/fundamentals/fmp)
 * run over the synthetic FMP fixtures, generated into `fundamentals.generated.json`.
 *
 * Regenerate with `npx tsx scripts/gen-fundamentals-mock.ts`. The server test
 * `server/fundamentals/fmp/mockData.test.ts` fails when the JSON is stale, so the
 * client mock cannot drift from the server mapping (Gate 5 finding F3).
 * `mocks/fundamentals.ts` only depends on the functions exported here.
 */
import type {
  EarningsResponse,
  FundamentalsOverview,
  NewsResponse,
  StatementKind,
  StatementPeriod,
  StatementsResponse,
} from '@shared/types';
import generated from './fundamentals.generated.json';

interface Generated {
  overview: Record<string, FundamentalsOverview>;
  statements: Record<string, Record<string, StatementsResponse>>;
  earnings: Record<string, EarningsResponse>;
  news: Record<string, NewsResponse>;
}
const data = generated as unknown as Generated;

export const MOCK_FUNDAMENTALS_SYMBOLS: readonly string[] = Object.keys(data.overview);

export function hasFundamentals(symbol: string): boolean {
  return MOCK_FUNDAMENTALS_SYMBOLS.includes(symbol);
}

export function overviewFor(symbol: string): FundamentalsOverview {
  return structuredClone(data.overview[symbol] as FundamentalsOverview);
}

export function statementsFor(symbol: string, statement: StatementKind, period: StatementPeriod): StatementsResponse {
  return structuredClone(data.statements[symbol]?.[`${statement}-${period}`] as StatementsResponse);
}

export function earningsFor(symbol: string): EarningsResponse {
  return structuredClone(data.earnings[symbol] as EarningsResponse);
}

export function newsFor(symbol: string): NewsResponse {
  return structuredClone(data.news[symbol] as NewsResponse);
}
