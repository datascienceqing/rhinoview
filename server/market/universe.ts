/**
 * The synthetic symbol universe.
 *
 * Tickers and names are real-looking so the UI is exercised realistically, but every
 * price and volume is generated: nothing here is market data. The numbers are only
 * "plausible": a base price (the post-split level at the anchor date), a daily
 * volatility, and an average daily volume in post-split shares.
 *
 * Deliberately included:
 *  - four recent listings (thin-history path), the newest only a few sessions old;
 *  - four symbols carrying synthetic splits, one of them with two (invariant 6);
 *  - names that match a search term their ticker does not ("bank", "motor", "energy",
 *    "semiconductor", "alphabet", ...).
 */
import type { EngineSymbol } from './types';
import { civilToDay, isTradingDay, nyWallToUnix } from './calendar';

export interface SplitEvent {
  /** First session trading at the post-split price: NY civil day number. */
  day: number;
  /** New shares per old share. Integer >= 2 (forward splits only). */
  ratio: number;
}

/** Everything the engine needs to know about a symbol. `EngineSymbol` is the public part. */
export interface SymbolModel extends EngineSymbol {
  /** Post-split price at the anchor date. */
  basePrice: number;
  /** Std-dev of daily log returns. */
  dailyVol: number;
  /** Mean shares traded per full session, post-split basis. */
  avgDailyVolume: number;
  /** Mean shares per trade; drives the `transactions` field. */
  tradeSize: number;
  /** Ascending by day. */
  splits: readonly SplitEvent[];
}

type Row = [
  symbol: string,
  name: string,
  exchange: 'XNAS' | 'XNYS',
  type: 'CS' | 'ETF',
  listed: string,
  basePrice: number,
  dailyVol: number,
  avgDailyVolumeMillions: number,
  splits?: [date: string, ratio: number][],
];

// prettier-ignore
const ROWS: Row[] = [
  // ── NASDAQ large caps ──
  ['AAPL', 'Apple Inc.', 'XNAS', 'CS', '1980-12-12', 225, 0.016, 55],
  ['MSFT', 'Microsoft Corporation', 'XNAS', 'CS', '1986-03-13', 430, 0.014, 22],
  ['GOOGL', 'Alphabet Inc. Class A', 'XNAS', 'CS', '2004-08-19', 175, 0.017, 28],
  ['AMZN', 'Amazon.com, Inc.', 'XNAS', 'CS', '1997-05-15', 200, 0.019, 42, [['2022-06-06', 20]]],
  ['NVDA', 'NVIDIA Corporation', 'XNAS', 'CS', '1999-01-22', 130, 0.032, 230, [['2021-07-20', 4], ['2024-06-10', 10]]],
  ['META', 'Meta Platforms, Inc. Class A', 'XNAS', 'CS', '2012-05-18', 590, 0.022, 14],
  ['TSLA', 'Tesla, Inc.', 'XNAS', 'CS', '2010-06-29', 250, 0.036, 95, [['2020-08-31', 5], ['2022-08-25', 3]]],
  ['AVGO', 'Broadcom Inc.', 'XNAS', 'CS', '2009-08-06', 170, 0.024, 20],
  ['COST', 'Costco Wholesale Corporation', 'XNAS', 'CS', '1985-12-05', 930, 0.013, 2],
  ['NFLX', 'Netflix, Inc.', 'XNAS', 'CS', '2002-05-23', 880, 0.022, 3.5],
  ['ADBE', 'Adobe Inc.', 'XNAS', 'CS', '1986-08-20', 410, 0.019, 3],
  ['CSCO', 'Cisco Systems, Inc.', 'XNAS', 'CS', '1990-02-16', 58, 0.014, 20],
  ['INTC', 'Intel Corporation', 'XNAS', 'CS', '1980-03-17', 24, 0.024, 45],
  ['AMD', 'Advanced Micro Devices, Inc.', 'XNAS', 'CS', '1980-03-17', 160, 0.03, 48],
  ['QCOM', 'QUALCOMM Incorporated', 'XNAS', 'CS', '1991-12-13', 165, 0.02, 8],
  ['PEP', 'PepsiCo, Inc.', 'XNAS', 'CS', '1981-09-30', 150, 0.011, 6],
  ['CMCSA', 'Comcast Corporation', 'XNAS', 'CS', '1972-06-29', 36, 0.016, 22],
  ['SBUX', 'Starbucks Corporation', 'XNAS', 'CS', '1992-06-26', 92, 0.017, 9],
  ['PYPL', 'PayPal Holdings, Inc.', 'XNAS', 'CS', '2015-07-20', 72, 0.022, 12],
  // ── NYSE large caps ──
  ['JPM', 'JPMorgan Chase & Co.', 'XNYS', 'CS', '1980-03-17', 240, 0.014, 9],
  ['BAC', 'Bank of America Corporation', 'XNYS', 'CS', '1980-03-17', 46, 0.016, 38],
  ['WFC', 'Wells Fargo & Company', 'XNYS', 'CS', '1980-03-17', 72, 0.016, 17],
  ['GS', 'The Goldman Sachs Group, Inc.', 'XNYS', 'CS', '1999-05-04', 560, 0.016, 2.2],
  ['V', 'Visa Inc. Class A', 'XNYS', 'CS', '2008-03-19', 305, 0.012, 7],
  ['MA', 'Mastercard Incorporated', 'XNYS', 'CS', '2006-05-25', 520, 0.013, 3],
  ['JNJ', 'Johnson & Johnson', 'XNYS', 'CS', '1980-03-17', 160, 0.009, 7],
  ['PFE', 'Pfizer Inc.', 'XNYS', 'CS', '1980-03-17', 26, 0.013, 38],
  ['UNH', 'UnitedHealth Group Incorporated', 'XNYS', 'CS', '1984-10-17', 520, 0.016, 3.5],
  ['XOM', 'Exxon Mobil Corporation', 'XNYS', 'CS', '1980-03-17', 112, 0.014, 15],
  ['CVX', 'Chevron Corporation', 'XNYS', 'CS', '1980-03-17', 150, 0.014, 8],
  ['KO', 'The Coca-Cola Company', 'XNYS', 'CS', '1980-03-17', 68, 0.009, 14],
  ['WMT', 'Walmart Inc.', 'XNYS', 'CS', '1980-03-17', 95, 0.011, 18, [['2024-02-26', 3]]],
  ['HD', 'The Home Depot, Inc.', 'XNYS', 'CS', '1981-09-22', 390, 0.014, 3.2],
  ['DIS', 'The Walt Disney Company', 'XNYS', 'CS', '1980-03-17', 105, 0.017, 9],
  ['F', 'Ford Motor Company', 'XNYS', 'CS', '1980-03-17', 11, 0.02, 55],
  ['GM', 'General Motors Company', 'XNYS', 'CS', '2010-11-18', 52, 0.02, 13],
  ['BRK.B', 'Berkshire Hathaway Inc. Class B', 'XNYS', 'CS', '1996-05-09', 480, 0.01, 4],
  ['T', 'AT&T Inc.', 'XNYS', 'CS', '1983-11-21', 24, 0.012, 32],
  ['NKE', 'NIKE, Inc. Class B', 'XNYS', 'CS', '1980-12-02', 78, 0.017, 10],
  ['BA', 'The Boeing Company', 'XNYS', 'CS', '1980-03-17', 185, 0.021, 8],
  ['CAT', 'Caterpillar Inc.', 'XNYS', 'CS', '1980-03-17', 380, 0.016, 2.6],
  ['UBER', 'Uber Technologies, Inc.', 'XNYS', 'CS', '2019-05-10', 82, 0.024, 20],
  // ── ETFs ──
  ['SPY', 'SPDR S&P 500 ETF Trust', 'XNYS', 'ETF', '1993-01-29', 600, 0.0085, 70],
  ['QQQ', 'Invesco QQQ Trust, Series 1', 'XNAS', 'ETF', '1999-03-10', 520, 0.011, 40],
  ['IWM', 'iShares Russell 2000 ETF', 'XNYS', 'ETF', '2000-05-26', 225, 0.012, 28],
  ['VTI', 'Vanguard Total Stock Market ETF', 'XNYS', 'ETF', '2001-05-31', 295, 0.0088, 4],
  ['XLK', 'Technology Select Sector SPDR Fund', 'XNYS', 'ETF', '1998-12-22', 235, 0.0115, 6],
  ['XLE', 'Energy Select Sector SPDR Fund', 'XNYS', 'ETF', '1998-12-22', 90, 0.013, 14],
  ['XLF', 'Financial Select Sector SPDR Fund', 'XNYS', 'ETF', '1998-12-22', 50, 0.0105, 38],
  ['SMH', 'VanEck Semiconductor ETF', 'XNAS', 'ETF', '2000-05-05', 255, 0.019, 6],
  ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'XNAS', 'ETF', '2002-07-26', 92, 0.0075, 30],
  ['GLD', 'SPDR Gold Shares', 'XNYS', 'ETF', '2004-11-18', 245, 0.0085, 9],
  // ── recent listings: thin history ──
  ['KRNL', 'Kernel Robotics, Inc.', 'XNAS', 'CS', '2026-09-24', 38, 0.045, 12],
  ['HLXR', 'Helixor Therapeutics, Inc.', 'XNYS', 'CS', '2026-08-17', 21, 0.05, 6],
  ['SOLQ', 'Solaris Quantum Corp.', 'XNAS', 'CS', '2026-06-01', 14.5, 0.055, 18],
  ['ARBN', 'Arbornet Cloud Systems, Inc.', 'XNYS', 'CS', '2025-11-20', 63, 0.035, 9],
];

const ANCHOR_BASE_TRADE_SIZE = 110;

function parseDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad date in universe: ${iso}`);
  return civilToDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

function buildModel(row: Row): SymbolModel {
  const [symbol, name, exchange, type, listed, basePrice, dailyVol, volMillions, rawSplits] = row;
  const listedDay = parseDay(listed);
  const splits = (rawSplits ?? [])
    .map(([date, ratio]) => ({ day: parseDay(date), ratio }))
    .sort((a, b) => a.day - b.day);

  // Fail at load, not mid-request: a split on a non-session or before listing is a data bug.
  for (const s of splits) {
    if (!isTradingDay(s.day)) throw new Error(`${symbol}: split ${s.day} is not a trading day`);
    if (s.day <= listedDay) throw new Error(`${symbol}: split precedes listing`);
    if (!Number.isInteger(s.ratio) || s.ratio < 2) throw new Error(`${symbol}: split ratio must be an integer >= 2`);
  }

  return {
    symbol,
    name,
    exchange,
    type,
    currency: 'USD',
    // 00:00 New York of the first session: also what a 1D bar for that day is stamped with.
    listedAt: nyWallToUnix(listedDay, 0),
    basePrice,
    dailyVol,
    avgDailyVolume: volMillions * 1_000_000,
    tradeSize: ANCHOR_BASE_TRADE_SIZE * (basePrice > 300 ? 0.5 : basePrice < 30 ? 1.8 : 1),
    splits,
  };
}

export const UNIVERSE: readonly SymbolModel[] = ROWS.map(buildModel);
