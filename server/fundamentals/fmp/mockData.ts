/**
 * The client MSW fundamentals data, built by running the real FMP mapper over the
 * (synthetic) FMP fixtures. Used by scripts/gen-fundamentals-mock.ts and guarded by
 * generatedMock.test.ts, so the client mock always matches the server mapping.
 */
import type {
  EarningsResponse,
  FundamentalsOverview,
  StatementKind,
  StatementPeriod,
  StatementsResponse,
} from '@shared/types';
import { createFixtureFundamentals } from './fixtureSource';

export const MOCK_SYMBOLS = ['AAPL', 'MSFT', 'JPM', 'TSM', 'RIVN'] as const;
const STATEMENTS: StatementKind[] = ['income', 'balance', 'cashflow'];
const PERIODS: StatementPeriod[] = ['annual', 'quarter'];
/** A fixed "data as of" time in Unix seconds, so the generated file is stable: 2026-10-02 20:00 UTC. */
export const MOCK_AS_OF = 1_790_971_200;

export interface FundamentalsMockData {
  overview: Record<string, FundamentalsOverview>;
  /** Keyed `${statement}-${period}`. */
  statements: Record<string, Record<string, StatementsResponse>>;
  earnings: Record<string, EarningsResponse>;
}

export async function buildFundamentalsMockData(): Promise<FundamentalsMockData> {
  const p = createFixtureFundamentals({ now: () => MOCK_AS_OF * 1000 });
  const data: FundamentalsMockData = { overview: {}, statements: {}, earnings: {} };
  for (const s of MOCK_SYMBOLS) {
    data.overview[s] = await p.getOverview(s);
    data.earnings[s] = await p.getEarnings(s);
    const bySymbol: Record<string, StatementsResponse> = {};
    for (const st of STATEMENTS) for (const per of PERIODS) bySymbol[`${st}-${per}`] = await p.getStatements(s, st, per);
    data.statements[s] = bySymbol;
  }
  return data;
}
