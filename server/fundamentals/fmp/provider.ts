/**
 * FMP fundamentals provider: fetches `/stable` endpoints, validates, and hands the rows
 * to the pure mapper. Caching is NOT here; `CachedFundamentalsProvider` wraps this.
 *
 * Unknown symbol: decided from `/profile` alone. Two signals mean unknown: an EMPTY ARRAY,
 * and a 402 whose body says the SYMBOL is restricted (`scope === 'symbol'`), which is how
 * FMP Starter answers a symbol it does not cover. This matches the market engine. A 402
 * with endpoint scope is a plan-tier failure and surfaces as UNAUTHORIZED: a 402 alone is
 * never read as "unknown", only its body's scope is.
 *
 * Partial success (invariant 7): after the profile, the five overview sections are
 * fetched together. A section that answers 402 or an empty array is listed as
 * `unavailable`. Any OTHER failure (429, 5xx, timeout, bad shape) fails the request: a
 * transient error must not become a six-hour cache entry with a hole in it.
 *
 * Gated data is never derived (invariant 8): only the endpoints below are called. There
 * is no `/ratios` and no `/key-metrics`; TTM values come from the TTM endpoints.
 */
import type {
  EarningsResponse,
  FundamentalsOverview,
  StatementKind,
  StatementPeriod,
  StatementsResponse,
} from '@shared/types';
import { UnknownSymbolError } from '../../market/types';
import { FmpPaymentRequiredError, FmpUpstreamError } from '../../market/fmp/client';
import type { FundamentalsProvider } from '../types';
import { MAX_STATEMENT_ROWS } from '../lineItems';
import { grossMarginIsInterestSpread, mapEarnings, mapOverview, mapStatements } from './mapper';
import type { FmpOverviewParts } from './mapper';
import {
  earningsResponse,
  gradesResponse,
  keyMetricsTtmResponse,
  priceTargetResponse,
  profileResponse,
  ratiosTtmResponse,
  scoresResponse,
  statementResponse,
} from './schemas';
import type { FmpProfileRow, FmpStatementRow } from './schemas';
import type { ZodType, ZodTypeDef } from 'zod';

/** What the provider needs from an HTTP client. `FmpClient` satisfies it; the fixture source does too. */
export interface FmpJsonSource {
  getJson(path: string, params: Record<string, string | number>): Promise<unknown>;
}

export interface FmpProviderOptions {
  source: FmpJsonSource;
  /** Milliseconds since the epoch; `asOf` is taken from it. Injectable for tests. */
  now?: () => number;
}

const STATEMENT_PATH: Record<StatementKind, string> = {
  income: '/income-statement',
  balance: '/balance-sheet-statement',
  cashflow: '/cash-flow-statement',
};

/** A fixed message: nothing from the upstream body or from zod's issue text is forwarded. */
function parseRows<T>(schema: ZodType<T[], ZodTypeDef, unknown>, path: string, body: unknown): T[] {
  const result = schema.safeParse(body);
  if (!result.success) throw new FmpUpstreamError(`FMP ${path} returned an unexpected shape`);
  return result.data;
}

export class FmpFundamentalsProvider implements FundamentalsProvider {
  readonly available = true;
  private readonly source: FmpJsonSource;
  private readonly now: () => number;

  constructor(opts: FmpProviderOptions) {
    this.source = opts.source;
    this.now = opts.now ?? Date.now;
  }

  async getOverview(symbol: string): Promise<FundamentalsOverview> {
    const profile = await this.fetchProfile(symbol);
    const sym = profile.symbol.toUpperCase();

    const [ratios, keyMetrics, scores, priceTarget, grades, latestIncome] = await Promise.all([
      this.section('/ratios-ttm', sym, ratiosTtmResponse),
      this.section('/key-metrics-ttm', sym, keyMetricsTtmResponse),
      this.section('/financial-scores', sym, scoresResponse),
      this.section('/price-target-consensus', sym, priceTargetResponse),
      this.section('/grades-consensus', sym, gradesResponse),
      this.latestAnnualIncome(sym),
    ]);

    const parts: FmpOverviewParts = {
      profile,
      ratios,
      keyMetrics,
      scores,
      priceTarget,
      grades,
      // The listing currency is the last resort: it is wrong for a company like TSM.
      reportedCurrency: scores?.reportedCurrency ?? latestIncome?.reportedCurrency ?? profile.currency,
      grossMarginNotMeaningful: grossMarginIsInterestSpread(latestIncome),
    };
    return mapOverview(parts, Math.floor(this.now() / 1000));
  }

  async getStatements(symbol: string, statement: StatementKind, period: StatementPeriod): Promise<StatementsResponse> {
    const profile = await this.fetchProfile(symbol);
    const sym = profile.symbol.toUpperCase();
    const path = STATEMENT_PATH[statement];
    const body = await this.source.getJson(path, {
      symbol: sym,
      period: period === 'annual' ? 'annual' : 'quarter',
      limit: MAX_STATEMENT_ROWS[period],
    });
    return mapStatements(sym, statement, period, parseRows(statementResponse, path, body));
  }

  async getEarnings(symbol: string): Promise<EarningsResponse> {
    const profile = await this.fetchProfile(symbol);
    const sym = profile.symbol.toUpperCase();
    const body = await this.source.getJson('/earnings', { symbol: sym });
    return mapEarnings(sym, parseRows(earningsResponse, '/earnings', body));
  }

  /** The unknown-symbol decision: an empty `profile` array, or a symbol-scope 402. */
  private async fetchProfile(symbol: string): Promise<FmpProfileRow> {
    let body: unknown;
    try {
      body = await this.source.getJson('/profile', { symbol: symbol.trim().toUpperCase() });
    } catch (err) {
      if (err instanceof FmpPaymentRequiredError && err.scope === 'symbol') throw new UnknownSymbolError(symbol);
      throw err;
    }
    const row = parseRows(profileResponse, '/profile', body)[0];
    if (!row) throw new UnknownSymbolError(symbol);
    return row;
  }

  /** First row of a section, or null when the plan tier lacks it (402) or FMP has no row. */
  private async section<T>(path: string, symbol: string, schema: ZodType<T[], ZodTypeDef, unknown>): Promise<T | null> {
    try {
      return parseRows(schema, path, await this.source.getJson(path, { symbol }))[0] ?? null;
    } catch (err) {
      if (err instanceof FmpPaymentRequiredError) return null;
      throw err;
    }
  }

  /**
   * The newest annual income statement, or null when it is gated. Two uses: it always
   * states the reporting currency (`financial-scores` may be gated), and it shows whether
   * the cost of revenue is mostly interest (`grossMarginIsInterestSpread`).
   */
  private async latestAnnualIncome(symbol: string): Promise<FmpStatementRow | null> {
    try {
      const body = await this.source.getJson(STATEMENT_PATH.income, { symbol, period: 'annual', limit: 1 });
      return parseRows(statementResponse, STATEMENT_PATH.income, body)[0] ?? null;
    } catch (err) {
      if (err instanceof FmpPaymentRequiredError) return null;
      throw err;
    }
  }
}
