/**
 * Runtime shapes of the FMP `/stable` responses the fundamentals provider reads. Only the
 * fields we use are declared. Shapes come from the recorded responses in `__fixtures__/fmp`.
 * A shape that no longer matches fails the request as UPSTREAM_ERROR instead of putting
 * NaN or undefined in front of the user.
 *
 * A missing, null or non-finite number becomes `null`. A present number, including 0 and
 * negatives, is kept as is (invariant 1: pass through what the provider supplies).
 */
import { z } from 'zod';

const nullableNumber = z
  .number()
  .finite()
  .nullish()
  .transform((v) => v ?? null);

/** FMP sends some counts as strings ("166000"). Anything that is not a plain number is null. */
const numberish = z
  .union([z.number().finite(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const nullableText = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() !== '' ? v : null));

/** `/profile` — a one-element array for a known symbol, an EMPTY array for an unknown one. */
export const profileRow = z.object({
  symbol: z.string().min(1),
  companyName: z.string().min(1),
  currency: z.string().min(1),
  exchange: nullableText,
  sector: nullableText,
  industry: nullableText,
  country: nullableText,
  website: nullableText,
  description: nullableText,
  ceo: nullableText,
  fullTimeEmployees: numberish,
  ipoDate: nullableText,
  marketCap: nullableNumber,
});
export const profileResponse = z.array(profileRow);
export type FmpProfileRow = z.infer<typeof profileRow>;

/** `/ratios-ttm`. FRACTIONS for margins, yields and payout (invariant 2). */
export const ratiosTtmRow = z.object({
  priceToEarningsRatioTTM: nullableNumber,
  priceToSalesRatioTTM: nullableNumber,
  priceToBookRatioTTM: nullableNumber,
  priceToEarningsGrowthRatioTTM: nullableNumber,
  grossProfitMarginTTM: nullableNumber,
  operatingProfitMarginTTM: nullableNumber,
  netProfitMarginTTM: nullableNumber,
  debtToEquityRatioTTM: nullableNumber,
  currentRatioTTM: nullableNumber,
  interestCoverageRatioTTM: nullableNumber,
  netIncomePerShareTTM: nullableNumber,
  revenuePerShareTTM: nullableNumber,
  freeCashFlowPerShareTTM: nullableNumber,
  bookValuePerShareTTM: nullableNumber,
  dividendYieldTTM: nullableNumber,
  dividendPayoutRatioTTM: nullableNumber,
});
export const ratiosTtmResponse = z.array(ratiosTtmRow);
export type FmpRatiosTtm = z.infer<typeof ratiosTtmRow>;

/** `/key-metrics-ttm`. */
export const keyMetricsTtmRow = z.object({
  evToEBITDATTM: nullableNumber,
  returnOnEquityTTM: nullableNumber,
  returnOnAssetsTTM: nullableNumber,
  returnOnInvestedCapitalTTM: nullableNumber,
});
export const keyMetricsTtmResponse = z.array(keyMetricsTtmRow);
export type FmpKeyMetricsTtm = z.infer<typeof keyMetricsTtmRow>;

/** `/financial-scores`. Also carries the currency the issuer reports in. */
export const scoresRow = z.object({
  reportedCurrency: nullableText,
  piotroskiScore: nullableNumber,
  altmanZScore: nullableNumber,
});
export const scoresResponse = z.array(scoresRow);
export type FmpScores = z.infer<typeof scoresRow>;

/** `/price-target-consensus`. */
export const priceTargetRow = z.object({
  targetHigh: nullableNumber,
  targetLow: nullableNumber,
  targetConsensus: nullableNumber,
  targetMedian: nullableNumber,
});
export const priceTargetResponse = z.array(priceTargetRow);
export type FmpPriceTarget = z.infer<typeof priceTargetRow>;

/** `/grades-consensus`. */
export const gradesRow = z.object({
  strongBuy: nullableNumber,
  buy: nullableNumber,
  hold: nullableNumber,
  sell: nullableNumber,
  strongSell: nullableNumber,
  consensus: nullableText,
});
export const gradesResponse = z.array(gradesRow);
export type FmpGrades = z.infer<typeof gradesRow>;

/**
 * One statement row. FMP puts the fiscal year in a STRING ("2026") and the period in
 * `period` ('FY' | 'Q1'..'Q4'). Line items are read by key afterwards, so the schema
 * only fixes the identity fields and keeps every other field as `unknown`.
 */
export const statementRow = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    filingDate: nullableText,
    reportedCurrency: z.string().min(1),
    fiscalYear: z.union([z.string(), z.number()]).transform((v, ctx) => {
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: 'custom', message: 'fiscalYear is not an integer' });
        return z.NEVER;
      }
      return n;
    }),
    period: z.enum(['FY', 'Q1', 'Q2', 'Q3', 'Q4']),
  })
  .passthrough();
export const statementResponse = z.array(statementRow);
export type FmpStatementRow = z.infer<typeof statementRow>;

/** `/earnings`. Upcoming reports have null actuals. */
export const earningsRow = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  epsActual: nullableNumber,
  epsEstimated: nullableNumber,
  revenueActual: nullableNumber,
  revenueEstimated: nullableNumber,
});
export const earningsResponse = z.array(earningsRow);
export type FmpEarningsRow = z.infer<typeof earningsRow>;
