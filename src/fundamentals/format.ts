/**
 * Presentation rules for fundamentals, in one place so every tab agrees.
 *
 *   null                         -> "—"            (the provider did not supply it)
 *   valuation multiple <= 0      -> "NM"           (negative earnings; reads as "cheap" otherwise)
 *   gross margin of a lender     -> "NM"           (the cost of revenue is mostly interest)
 *   fraction                     -> percent        (0.4865 -> 48.65%)
 *
 * The raw value stays raw all the way down; only these functions decide what is shown.
 */
import { t } from '../i18n';
import { getLocale } from '../i18n/locale';

export const DASH = '—';
/** The English texts, for tests; the functions below use the current language. */
export const NM = 'NM';
export const NM_NEGATIVE_EARNINGS = 'not meaningful: negative earnings';
export const NM_INTEREST_SPREAD = 'not meaningful: the cost of revenue is mostly interest expense, so this is a lending spread';

/** A displayed value plus an optional tooltip explaining it. */
export interface Cell {
  text: string;
  title?: string;
}

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function formatNumber(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A fraction as a percentage: 0.4865 -> "48.65%". */
export function formatFraction(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  return `${formatNumber(v * 100, digits)}%`;
}

/** A value that is already a percentage (surprise %): 5.2 -> "+5.20%". */
export function formatSignedPercent(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v > 0 ? '+' : ''}${formatNumber(v, 2)}%`;
}

/**
 * Large amounts: 1.27T, 394.33B, 12.50M. Below one million, grouped digits with no decimals.
 * In Chinese: 1.27万亿, 3943.30亿, 1250.00万 (万 = 10^4, 亿 = 10^8), below 10 000 grouped digits.
 */
export function formatLarge(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return scaleLarge(v, (x) => formatNumber(x), (x) => formatNumber(x, 0));
}

/** An axis tick: no zeros after the point. 2 -> "2", 2.5 -> "2.5", 0.025 -> "0.03". */
export function formatTick(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A large amount as an axis tick, in the units of formatLarge: 400B, 2.5B, 500M. */
export function formatLargeTick(v: number): string {
  return scaleLarge(v, formatTick, formatTick);
}

/** A fraction as an axis tick: 0.1 -> "10%", 0.025 -> "2.5%". */
export function formatFractionTick(v: number): string {
  return `${formatTick(v * 100)}%`;
}

function scaleLarge(v: number, scaled: (x: number) => string, plain: (x: number) => string): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (getLocale() === 'zh') {
    if (abs >= 1e12) return `${sign}${scaled(abs / 1e12)}万亿`;
    if (abs >= 1e8) return `${sign}${scaled(abs / 1e8)}亿`;
    if (abs >= 1e4) return `${sign}${scaled(abs / 1e4)}万`;
    return plain(v);
  }
  if (abs >= 1e12) return `${sign}${scaled(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}${scaled(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${scaled(abs / 1e6)}M`;
  return plain(v);
}

/** A P/E, PEG, EV/EBITDA, P/S or P/B. Zero or negative is not meaningful. */
export function multipleCell(v: number | null | undefined): Cell {
  if (!isNum(v)) return { text: DASH };
  if (v <= 0) return { text: t('fund.nm'), title: t('fund.nmNegative') };
  return { text: `${formatNumber(v)}x` };
}

/**
 * A margin. `notMeaningful` comes from the server's `grossMarginNotMeaningful` and applies
 * to the GROSS margin only: a lender's operating and net margins are real numbers.
 */
export function marginCell(v: number | null | undefined, notMeaningful: boolean): Cell {
  if (notMeaningful) return { text: t('fund.nm'), title: t('fund.nmInterest') };
  return { text: formatFraction(v) };
}


/** "FY2026" for annual rows, "Q1 FY2026" for quarterly rows (2026财年, 2026财年Q1). Never a calendar year. */
export function fiscalLabel(row: { fiscalYear: number; fiscalPeriod: string }): string {
  return row.fiscalPeriod === 'FY'
    ? t('fund.fiscal.annual', { year: row.fiscalYear })
    : t('fund.fiscal.quarter', { year: row.fiscalYear, quarter: row.fiscalPeriod });
}
