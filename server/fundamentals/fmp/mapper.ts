/**
 * Pure mapping from parsed FMP rows to the contract's fundamentals types. No I/O, no
 * clock, no cache: the provider fetches, this module maps. It is exported on its own so
 * the recorded fixtures can be pushed through it (see `fixtureSource.ts`).
 *
 * Rules that live here, each tested against the recorded responses:
 *   - A value FMP supplies is copied unchanged, even if it is not meaningful (JPM gross
 *     margin 0.626, RIVN P/E -5.54). A value FMP omits is `null`. Never 0, never a guess.
 *   - Ratios are already fractions in the TTM endpoints, so nothing is divided by 100.
 *   - Fiscal year and period come from the row. The calendar date is never consulted.
 *   - Rows are sorted newest first and cut to the contract's 10 years / 8 quarters.
 *   - Nothing is derived: no quarterly ratios, no P/E from price and EPS (invariant 4, 8).
 */
import type {
  AnalystConsensus,
  CompanyProfile,
  EarningsEvent,
  EarningsResponse,
  FinancialScores,
  FundamentalsOverview,
  KeyMetricsTTM,
  StatementKind,
  StatementPeriod,
  StatementRow,
  StatementsResponse,
} from '@shared/types';
import { LINE_ITEMS, MAX_STATEMENT_ROWS, lineItemsFor } from '../lineItems';
import type {
  FmpEarningsRow,
  FmpGrades,
  FmpKeyMetricsTtm,
  FmpPriceTarget,
  FmpProfileRow,
  FmpRatiosTtm,
  FmpScores,
  FmpStatementRow,
} from './schemas';

export function mapProfile(row: FmpProfileRow): CompanyProfile {
  return {
    symbol: row.symbol.toUpperCase(),
    name: row.companyName,
    exchange: row.exchange,
    sector: row.sector,
    industry: row.industry,
    country: row.country,
    website: row.website,
    description: row.description,
    ceo: row.ceo,
    employees: row.fullTimeEmployees,
    ipoDate: row.ipoDate,
    currency: row.currency,
    marketCap: row.marketCap,
  };
}

/**
 * Either source may be absent (plan tier). A missing source nulls only its own fields;
 * the caller reports `metrics` as unavailable when BOTH are absent.
 *
 * `epsDiluted` reads `netIncomePerShareTTM`: FMP supplies no TTM diluted EPS field, and
 * this is its own per-share earnings figure in the reporting currency (TSM: TWD).
 */
export function mapMetrics(ratios: FmpRatiosTtm | null, keyMetrics: FmpKeyMetricsTtm | null): KeyMetricsTTM {
  return {
    peRatio: ratios?.priceToEarningsRatioTTM ?? null,
    priceToSales: ratios?.priceToSalesRatioTTM ?? null,
    priceToBook: ratios?.priceToBookRatioTTM ?? null,
    evToEbitda: keyMetrics?.evToEBITDATTM ?? null,
    pegRatio: ratios?.priceToEarningsGrowthRatioTTM ?? null,
    grossMargin: ratios?.grossProfitMarginTTM ?? null,
    operatingMargin: ratios?.operatingProfitMarginTTM ?? null,
    netMargin: ratios?.netProfitMarginTTM ?? null,
    returnOnEquity: keyMetrics?.returnOnEquityTTM ?? null,
    returnOnAssets: keyMetrics?.returnOnAssetsTTM ?? null,
    returnOnInvestedCapital: keyMetrics?.returnOnInvestedCapitalTTM ?? null,
    debtToEquity: ratios?.debtToEquityRatioTTM ?? null,
    currentRatio: ratios?.currentRatioTTM ?? null,
    interestCoverage: ratios?.interestCoverageRatioTTM ?? null,
    epsDiluted: ratios?.netIncomePerShareTTM ?? null,
    revenuePerShare: ratios?.revenuePerShareTTM ?? null,
    freeCashFlowPerShare: ratios?.freeCashFlowPerShareTTM ?? null,
    bookValuePerShare: ratios?.bookValuePerShareTTM ?? null,
    dividendYield: ratios?.dividendYieldTTM ?? null,
    payoutRatio: ratios?.dividendPayoutRatioTTM ?? null,
  };
}

export function mapScores(row: FmpScores | null): FinancialScores {
  return { piotroskiScore: row?.piotroskiScore ?? null, altmanZScore: row?.altmanZScore ?? null };
}

export function mapAnalyst(target: FmpPriceTarget | null, grades: FmpGrades | null): AnalystConsensus {
  return {
    targetHigh: target?.targetHigh ?? null,
    targetLow: target?.targetLow ?? null,
    targetConsensus: target?.targetConsensus ?? null,
    targetMedian: target?.targetMedian ?? null,
    strongBuy: grades?.strongBuy ?? null,
    buy: grades?.buy ?? null,
    hold: grades?.hold ?? null,
    sell: grades?.sell ?? null,
    strongSell: grades?.strongSell ?? null,
    consensus: grades?.consensus ?? null,
  };
}

/** The first row of each section, or `null` when the section is not served (402 or empty array). */
export interface FmpOverviewParts {
  profile: FmpProfileRow;
  ratios: FmpRatiosTtm | null;
  keyMetrics: FmpKeyMetricsTtm | null;
  scores: FmpScores | null;
  priceTarget: FmpPriceTarget | null;
  grades: FmpGrades | null;
  /** The currency the issuer REPORTS in; the provider resolves it (see `FmpProvider`). */
  reportedCurrency: string;
}

export function mapOverview(parts: FmpOverviewParts, asOf: number): FundamentalsOverview {
  const unavailable: FundamentalsOverview['unavailable'] = [];
  if (!parts.ratios && !parts.keyMetrics) unavailable.push('metrics');
  if (!parts.scores) unavailable.push('scores');
  if (!parts.priceTarget && !parts.grades) unavailable.push('analyst');
  return {
    profile: mapProfile(parts.profile),
    metrics: mapMetrics(parts.ratios, parts.keyMetrics),
    scores: mapScores(parts.scores),
    analyst: mapAnalyst(parts.priceTarget, parts.grades),
    reportedCurrency: parts.reportedCurrency,
    asOf,
    unavailable,
  };
}

function mapStatementRow(row: FmpStatementRow, statement: StatementKind): StatementRow {
  const lines: Record<string, number | null> = {};
  for (const { key } of LINE_ITEMS[statement]) {
    const v = row[key];
    lines[key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return {
    fiscalYear: row.fiscalYear,
    fiscalPeriod: row.period,
    periodEnd: row.date,
    filingDate: row.filingDate,
    reportedCurrency: row.reportedCurrency,
    lines,
  };
}

/** Newest first: by period end, then by fiscal period so Q4 precedes Q3 on an (impossible) tie. */
function newestFirst(a: StatementRow, b: StatementRow): number {
  if (a.periodEnd !== b.periodEnd) return a.periodEnd < b.periodEnd ? 1 : -1;
  return a.fiscalPeriod < b.fiscalPeriod ? 1 : a.fiscalPeriod > b.fiscalPeriod ? -1 : 0;
}

export function mapStatements(
  symbol: string,
  statement: StatementKind,
  period: StatementPeriod,
  rows: readonly FmpStatementRow[],
): StatementsResponse {
  const wantFy = period === 'annual';
  const mapped = rows
    .filter((r) => (r.period === 'FY') === wantFy)
    .map((r) => mapStatementRow(r, statement))
    .sort(newestFirst)
    .slice(0, MAX_STATEMENT_ROWS[period]);
  return { symbol, statement, period, lineItems: lineItemsFor(statement), rows: mapped };
}

export function mapEarnings(symbol: string, rows: readonly FmpEarningsRow[]): EarningsResponse {
  const events: EarningsEvent[] = rows
    .map((r) => ({
      date: r.date,
      epsActual: r.epsActual,
      epsEstimate: r.epsEstimated,
      revenueActual: r.revenueActual,
      revenueEstimate: r.revenueEstimated,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { symbol, events };
}
