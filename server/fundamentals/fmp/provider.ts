/**
 * FMP fundamentals provider: fetches `/stable` endpoints, validates, and hands the rows
 * to the pure mapper. Caching is NOT here; `CachedFundamentalsProvider` wraps this.
 *
 * Unknown symbol (invariant 7 and the plan): decided from `/profile` alone, by an EMPTY
 * ARRAY. FMP overloads HTTP 402 for restricted and for unknown symbols, so a 402 is never
 * read as "unknown": a 402 profile surfaces as UNAUTHORIZED.
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
import { mapEarnings, mapOverview, mapStatements } from './mapper';
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
import type { FmpProfileRow } from './schemas';
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

    const [ratios, keyMetrics, scores, priceTarget, grades] = await Promise.all([
      this.section('/ratios-ttm', sym, ratiosTtmResponse),
      this.section('/key-metrics-ttm', sym, keyMetricsTtmResponse),
      this.section('/financial-scores', sym, scoresResponse),
      this.section('/price-target-consensus', sym, priceTargetResponse),
      this.section('/grades-consensus', sym, gradesResponse),
    ]);

    const parts: FmpOverviewParts = {
      profile,
      ratios,
      keyMetrics,
      scores,
      priceTarget,
      grades,
      reportedCurrency: scores?.reportedCurrency ?? (await this.currencyFromStatements(sym)) ?? profile.currency,
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

  /** The unknown-symbol decision: an empty `profile` array, and nothing else. */
  private async fetchProfile(symbol: string): Promise<FmpProfileRow> {
    const body = await this.source.getJson('/profile', { symbol: symbol.trim().toUpperCase() });
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
   * `financial-scores` carries the reporting currency but may be gated. Fall back to the
   * newest annual income statement, which always states it. The listing currency is the
   * last resort and is wrong for a company like TSM, so it is tried only after both.
   */
  private async currencyFromStatements(symbol: string): Promise<string | null> {
    try {
      const body = await this.source.getJson(STATEMENT_PATH.income, { symbol, period: 'annual', limit: 1 });
      return parseRows(statementResponse, STATEMENT_PATH.income, body)[0]?.reportedCurrency ?? null;
    } catch (err) {
      if (err instanceof FmpPaymentRequiredError) return null;
      throw err;
    }
  }
}
