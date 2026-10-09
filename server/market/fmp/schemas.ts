/**
 * Runtime shapes of the FMP `/stable` responses this provider reads, validated with zod
 * so a change upstream becomes a clean UPSTREAM_ERROR instead of NaN on a chart.
 *
 * Only the fields we use are declared; unknown fields are ignored. Shapes come from
 * recorded responses in `__fixtures__/`, not from documentation.
 */
import { z } from 'zod';

const finite = z.number().finite();
const nullableNumber = finite.nullish().transform((v) => v ?? null);

/** One row of `historical-price-eod/full`. */
export const eodRowSchema = z.object({
  date: z.string(),
  open: finite,
  high: finite,
  low: finite,
  close: finite,
  volume: finite,
  vwap: nullableNumber,
});
export type EodRow = z.infer<typeof eodRowSchema>;
export const eodResponseSchema = z.array(eodRowSchema);

/**
 * One row of `historical-chart/{5min,15min,1hour}`. `date` is a New York WALL-CLOCK string
 * ("2026-10-02 09:30:00"), no zone. Note the key order differs from EOD; only names matter.
 */
export const intradayRowSchema = z.object({
  date: z.string(),
  open: finite,
  high: finite,
  low: finite,
  close: finite,
  volume: finite,
});
export type IntradayRow = z.infer<typeof intradayRowSchema>;
export const intradayResponseSchema = z.array(intradayRowSchema);

/** `quote` returns a one-element array. */
export const quoteRowSchema = z.object({
  symbol: z.string(),
  price: nullableNumber,
  /** A PERCENTAGE: 1.02022 means +1.02%. Our `Snapshot.changePercent` is a fraction. */
  changePercentage: nullableNumber,
  change: nullableNumber,
  volume: nullableNumber,
  dayLow: nullableNumber,
  dayHigh: nullableNumber,
  open: nullableNumber,
  previousClose: nullableNumber,
  /** Unix SECONDS already (verified: 1790971201 is 2026-10-02T20:00:01Z, the NYSE close). */
  timestamp: nullableNumber,
});
export type QuoteRow = z.infer<typeof quoteRowSchema>;
export const quoteResponseSchema = z.array(quoteRowSchema);

/** `search-symbol` rows. */
export const searchRowSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().nullish().transform((v) => v ?? null),
  currency: z.string().nullish().transform((v) => v || null),
  exchange: z.string().nullish().transform((v) => v || null),
});
export type SearchRow = z.infer<typeof searchRowSchema>;
export const searchResponseSchema = z.array(searchRowSchema);

/** `profile` rows (company metadata). */
export const profileRowSchema = z.object({
  symbol: z.string().min(1),
  companyName: z.string().nullish().transform((v) => v ?? null),
  currency: z.string().nullish().transform((v) => v || null),
  exchange: z.string().nullish().transform((v) => v || null),
  ipoDate: z.string().nullish().transform((v) => v || null),
  isEtf: z.boolean().nullish().transform((v) => v ?? false),
  isFund: z.boolean().nullish().transform((v) => v ?? false),
  isAdr: z.boolean().nullish().transform((v) => v ?? false),
});
export type ProfileRow = z.infer<typeof profileRowSchema>;
export const profileResponseSchema = z.array(profileRowSchema);
