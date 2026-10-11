/**
 * Replace the values in the FMP test fixtures with SYNTHETIC data of the same shape.
 *
 *   npx tsx scripts/gen-synthetic-fmp-fixtures.ts
 *
 * The fixtures were first recorded from the real FMP API. Market data may not be
 * redistributed, so this script keeps only their SHAPE: file names, wrappers, keys, row
 * counts, row order, dates, fiscal labels, currencies, identifiers, which values are null
 * or zero, and the sign and integer-ness of each number. Every price, volume, amount,
 * ratio and text is replaced:
 *
 *   - Prices and bars come from a deterministic random walk per file.
 *   - Statements come from a small invented model per company (COMPANIES below). The
 *     identities the tests rely on hold exactly: four quarters sum to their fiscal year
 *     (income, cash flow), and the fiscal-year balance sheet is the Q4 balance sheet.
 *   - Any other number keeps its sign, zero and power of ten, with new digits.
 *
 * DETERMINISTIC AND IDEMPOTENT. A new value depends only on the file, the row, the key,
 * and the sign, zero, integer-ness and power of ten of the old value, never on its digits.
 * A second run therefore writes the same files.
 *
 * Not changed, on purpose: HTTP error bodies (402) are FMP's error text, and the client
 * reads the scope of a 402 from that text; empty responses; split events and symbol-search
 * listings, which are public listing facts and not market data.
 *
 * After this script, run `npx tsx scripts/gen-fundamentals-mock.ts` to rebuild
 * mocks/fundamentals.generated.json from the new fixtures.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = join(ROOT, 'server/market/fmp/__fixtures__');
const FUND = join(ROOT, 'server/fundamentals/__fixtures__/fmp');

type Num = number;
type Row = Record<string, unknown>;

// ───────────────────────────── determinism ─────────────────────────────

/** FNV-1a: a stable 32-bit hash of a string. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A uniform number in [0, 1) that depends only on `key`. */
function u(key: string): number {
  let t = (hash(key) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [-1, 1). */
const sym = (key: string) => 2 * u(key) - 1;

function decimalsOf(v: number): number {
  const s = String(v);
  if (s.includes('e')) return 6;
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/**
 * A new number with the sign, zero, integer-ness and power of ten of `v`, and new digits.
 * Stays in the same power of ten (mantissa 1.0-9.9), so a second run keeps the same shape.
 */
function generic(v: Num, key: string): Num {
  if (v === 0 || !Number.isFinite(v)) return v;
  const sign = Math.sign(v);
  const p = Math.floor(Math.log10(Math.abs(v)));
  const mantissa = 1 + 8.9 * u(key);
  if (Number.isInteger(v)) return sign * Math.max(1, Math.round(mantissa * 10 ** p));
  return sign * round(mantissa * 10 ** p, Math.max(2, decimalsOf(v)));
}

/** `generic` over every number in a row, except the keys in `keep`. */
function genericRow(row: Row, key: string, keep: ReadonlySet<string> = new Set()): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'number' && !keep.has(k) ? generic(v, `${key}:${k}`) : v;
  return out;
}

// ───────────────────────────── invented company model ─────────────────────────────

interface Company {
  /** Quarterly revenue, in the reporting currency. Invented. */
  revenueQ: number;
  grossMargin: number;
  rd: number;
  sga: number;
  tax: number;
  shares: number;
  /** Lenders: most of the cost of revenue is interest expense (see mapper.grossMarginIsInterestSpread). */
  lender: boolean;
  price: number;
  assetsToRevenueQ: number;
  equityShare: number;
  /** Units of the reporting currency for one unit of the listing currency (TSM: TWD per USD). */
  fx: number;
}

const COMPANIES: Record<string, Company> = {
  AAPL: { revenueQ: 8.2e10, grossMargin: 0.44, rd: 0.07, sga: 0.06, tax: 0.15, shares: 1.52e10, lender: false, price: 182.4, assetsToRevenueQ: 4.1, equityShare: 0.18, fx: 1 },
  MSFT: { revenueQ: 6.1e10, grossMargin: 0.67, rd: 0.12, sga: 0.1, tax: 0.18, shares: 7.45e9, lender: false, price: 404.7, assetsToRevenueQ: 8.3, equityShare: 0.47, fx: 1 },
  JPM: { revenueQ: 5.8e10, grossMargin: 0.6, rd: 0, sga: 0.3, tax: 0.22, shares: 2.83e9, lender: true, price: 197.2, assetsToRevenueQ: 62, equityShare: 0.085, fx: 1 },
  // TSM reports in TWD and trades in USD; its EPS in TWD is larger than its USD price (a test relies on it).
  TSM: { revenueQ: 7.9e11, grossMargin: 0.57, rd: 0.07, sga: 0.03, tax: 0.14, shares: 9.9e9, lender: false, price: 158.9, assetsToRevenueQ: 7.2, equityShare: 0.66, fx: 31.5 },
  RIVN: { revenueQ: 1.15e9, grossMargin: -0.06, rd: 0.34, sga: 0.28, tax: 0, shares: 1.08e9, lender: false, price: 12.4, assetsToRevenueQ: 13, equityShare: 0.4, fx: 1 },
  NVDA: { revenueQ: 3.1e10, grossMargin: 0.72, rd: 0.1, sga: 0.03, tax: 0.13, shares: 2.44e10, lender: false, price: 118.6, assetsToRevenueQ: 3.6, equityShare: 0.7, fx: 1 },
};

const SEASON: Record<string, number> = { Q1: 1.06, Q2: 0.97, Q3: 0.96, Q4: 1.01 };

function company(symbol: string): Company {
  const c = COMPANIES[symbol];
  if (!c) throw new Error(`no invented company model for ${symbol}`);
  return c;
}

// ───────────────────────────── statements ─────────────────────────────

const i = Math.round;

/** The modeled income lines for revenue `r`. Every other numeric key is `generic`. */
function incomeModel(c: Company, r: number, key: string): Row {
  const cost = i(r * (1 - c.grossMargin));
  const gross = r - cost;
  const rd = i(r * c.rd);
  const sga = i(r * c.sga * (1 + 0.04 * sym(`${key}:sga`)));
  const opex = rd + sga;
  const operating = gross - opex;
  const interest = c.lender ? i(cost * (0.84 + 0.04 * u(`${key}:int`))) : i(r * 0.004 * u(`${key}:int`));
  const other = i(r * 0.01 * sym(`${key}:other`));
  const ibt = operating + other;
  const taxExp = ibt > 0 ? i(ibt * c.tax) : 0;
  const net = ibt - taxExp;
  const da = i(r * 0.035);
  const shares = i(c.shares * (1 - 0.003 * u(`${key}:sh`)));
  const sharesDil = i(shares * 1.004);
  return {
    revenue: r,
    costOfRevenue: cost,
    grossProfit: gross,
    researchAndDevelopmentExpenses: rd,
    sellingGeneralAndAdministrativeExpenses: sga,
    operatingExpenses: opex,
    costAndExpenses: cost + opex,
    interestExpense: interest,
    depreciationAndAmortization: da,
    operatingIncome: operating,
    ebit: operating,
    ebitda: operating + da,
    totalOtherIncomeExpensesNet: other,
    incomeBeforeTax: ibt,
    incomeTaxExpense: taxExp,
    netIncomeFromContinuingOperations: net,
    netIncome: net,
    bottomLineNetIncome: net,
    weightedAverageShsOut: shares,
    weightedAverageShsOutDil: sharesDil,
    eps: round(net / shares, 2),
    epsDiluted: round(net / sharesDil, 2),
  };
}

/** Keys that are not flows: an annual value is not the sum of its quarters. */
const NOT_SUMMED = new Set(['eps', 'epsDiluted', 'weightedAverageShsOut', 'weightedAverageShsOutDil', 'cashAtBeginningOfPeriod', 'cashAtEndOfPeriod']);

function balanceModel(c: Company, assets: number, cash: number, key: string): Row {
  const sti = i(assets * 0.05 * u(`${key}:sti`));
  const receivables = i(assets * 0.08);
  const inventory = c.lender ? 0 : i(assets * 0.02);
  const currentAssets = cash + sti + receivables + inventory;
  const nonCurrent = assets - currentAssets;
  const equity = i(assets * c.equityShare);
  const liabilities = assets - equity;
  const currentLiab = i(liabilities * 0.4);
  const shortDebt = i(liabilities * 0.04);
  const longDebt = i(liabilities * 0.22);
  return {
    cashAndCashEquivalents: cash,
    shortTermInvestments: sti,
    cashAndShortTermInvestments: cash + sti,
    netReceivables: receivables,
    accountsReceivables: receivables,
    inventory,
    totalCurrentAssets: currentAssets,
    totalNonCurrentAssets: nonCurrent,
    totalAssets: assets,
    shortTermDebt: shortDebt,
    totalCurrentLiabilities: currentLiab,
    longTermDebt: longDebt,
    totalNonCurrentLiabilities: liabilities - currentLiab,
    totalLiabilities: liabilities,
    totalStockholdersEquity: equity,
    totalEquity: equity,
    totalLiabilitiesAndTotalEquity: assets,
    totalDebt: shortDebt + longDebt,
    netDebt: shortDebt + longDebt - cash,
  };
}

function cashflowModel(income: Row, cashBegin: number, key: string): Row {
  const net = income['netIncome'] as number;
  const r = income['revenue'] as number;
  const da = income['depreciationAndAmortization'] as number;
  const sbc = i(r * 0.02);
  const wc = i(r * 0.02 * sym(`${key}:wc`));
  const ocf = net + da + sbc + wc;
  const capex = -i(r * 0.05);
  const investing = capex - i(r * 0.01 * u(`${key}:inv`));
  const financing = -i(r * 0.06 * u(`${key}:fin`));
  const change = ocf + investing + financing;
  return {
    netIncome: net,
    depreciationAndAmortization: da,
    stockBasedCompensation: sbc,
    changeInWorkingCapital: wc,
    netCashProvidedByOperatingActivities: ocf,
    operatingCashFlow: ocf,
    investmentsInPropertyPlantAndEquipment: capex,
    capitalExpenditure: capex,
    freeCashFlow: ocf + capex,
    netCashProvidedByInvestingActivities: investing,
    netCashProvidedByFinancingActivities: financing,
    effectOfForexChangesOnCash: 0,
    netChangeInCash: change,
    cashAtBeginningOfPeriod: cashBegin,
    cashAtEndOfPeriod: cashBegin + change,
  };
}

/** Keep the old row's keys and order; take modeled values, else `generic`; keep zeros and nulls. */
function fill(old: Row, modeled: Row, key: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(old)) {
    if (typeof v !== 'number') out[k] = v;
    else if (k in modeled && v !== 0) out[k] = modeled[k];
    else out[k] = generic(v, `${key}:${k}`);
  }
  return out;
}

function sumRows(rows: Row[], template: Row, key: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(template)) {
    if (typeof v !== 'number') out[k] = v;
    else if (NOT_SUMMED.has(k)) out[k] = generic(v, `${key}:${k}`); // fixed below where it matters
    else out[k] = rows.reduce((acc, r) => acc + (r[k] as number), 0);
  }
  return out;
}

interface StatementSet {
  income: { annual: Row[]; quarter: Row[] };
  balance: { annual: Row[]; quarter: Row[] };
  cashflow: { annual: Row[]; quarter: Row[] };
}

function synthesizeStatements(symbol: string, old: StatementSet): StatementSet {
  const c = company(symbol);
  const byDateAsc = (rows: Row[]) => [...rows].sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
  const orderLike = (oldRows: Row[], made: Map<string, Row>) => oldRows.map((r) => made.get(String(r['date'])) as Row);

  // Income, quarters: growth over time, a seasonal shape, a little noise.
  const qIncome = new Map<string, Row>();
  byDateAsc(old.income.quarter).forEach((r, t) => {
    const key = `${symbol}:income:q:${r['date']}`;
    const rev = i(c.revenueQ * (1 + 0.015 * t) * (SEASON[String(r['period'])] ?? 1) * (1 + 0.03 * sym(key)));
    qIncome.set(String(r['date']), fill(r, incomeModel(c, rev, key), key));
  });
  const quartersOf = (fy: string, made: Map<string, Row>, oldQ: Row[]) =>
    oldQ.filter((r) => r['fiscalYear'] === fy).map((r) => made.get(String(r['date'])) as Row);

  // Income, annual: the exact sum of the four quarters when they are all here, else modeled.
  const newestQuarterYear = Math.max(...old.income.quarter.map((r) => Number(r['fiscalYear'])));
  const aIncome = new Map<string, Row>();
  for (const r of old.income.annual) {
    const fy = String(r['fiscalYear']);
    const key = `${symbol}:income:a:${r['date']}`;
    const qs = quartersOf(fy, qIncome, old.income.quarter);
    if (qs.length === 4) {
      const sum = sumRows(qs, r, key);
      const shares = i(qs.reduce((a, q) => a + (q['weightedAverageShsOut'] as number), 0) / 4);
      const sharesDil = i(shares * 1.004);
      const net = sum['netIncome'] as number;
      Object.assign(sum, { weightedAverageShsOut: shares, weightedAverageShsOutDil: sharesDil, eps: round(net / shares, 2), epsDiluted: round(net / sharesDil, 2) });
      aIncome.set(String(r['date']), fill(r, sum, key));
    } else {
      const yearsBack = newestQuarterYear - Number(fy);
      const rev = i(4 * c.revenueQ * (1 - 0.06 * yearsBack) * (1 + 0.02 * sym(key)));
      aIncome.set(String(r['date']), fill(r, incomeModel(c, rev, key), key));
    }
  }

  // Balance, quarters.
  const qBalance = new Map<string, Row>();
  byDateAsc(old.balance.quarter).forEach((r, t) => {
    const key = `${symbol}:balance:q:${r['date']}`;
    const assets = i(c.revenueQ * c.assetsToRevenueQ * (1 + 0.012 * t) * (1 + 0.01 * sym(key)));
    const cash = i(assets * (0.04 + 0.03 * u(`${key}:cash`)));
    qBalance.set(String(r['date']), fill(r, balanceModel(c, assets, cash, key), key));
  });
  // Balance, annual: a stock, so the fiscal-year value IS the Q4 value.
  const aBalance = new Map<string, Row>();
  for (const r of old.balance.annual) {
    const fy = String(r['fiscalYear']);
    const key = `${symbol}:balance:a:${r['date']}`;
    const q4old = old.balance.quarter.find((q) => q['fiscalYear'] === fy && q['period'] === 'Q4');
    if (q4old) {
      const q4 = qBalance.get(String(q4old['date'])) as Row;
      const copy: Row = {};
      for (const [k, v] of Object.entries(r)) copy[k] = typeof v === 'number' ? q4[k] : v;
      aBalance.set(String(r['date']), copy);
    } else {
      const yearsBack = newestQuarterYear - Number(fy);
      const assets = i(c.revenueQ * c.assetsToRevenueQ * (1 - 0.05 * yearsBack));
      const cash = i(assets * (0.04 + 0.03 * u(`${key}:cash`)));
      aBalance.set(String(r['date']), fill(r, balanceModel(c, assets, cash, key), key));
    }
  }

  // Cash flow, quarters: net income and revenue come from the income quarter of the same date.
  const qCash = new Map<string, Row>();
  let cash = i(c.revenueQ * c.assetsToRevenueQ * 0.05);
  for (const r of byDateAsc(old.cashflow.quarter)) {
    const key = `${symbol}:cashflow:q:${r['date']}`;
    const inc = qIncome.get(String(r['date']));
    if (!inc) throw new Error(`${symbol}: no income quarter for cash flow ${r['date']}`);
    const made = fill(r, cashflowModel(inc, cash, key), key);
    cash = made['cashAtEndOfPeriod'] as number;
    qCash.set(String(r['date']), made);
  }
  // Cash flow, annual: flows sum; the year starts with Q1's opening cash and ends with Q4's closing cash.
  const aCash = new Map<string, Row>();
  for (const r of old.cashflow.annual) {
    const fy = String(r['fiscalYear']);
    const key = `${symbol}:cashflow:a:${r['date']}`;
    const qs = quartersOf(fy, qCash, old.cashflow.quarter);
    if (qs.length === 4) {
      const asc = [...qs].sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
      const sum = sumRows(qs, r, key);
      sum['cashAtBeginningOfPeriod'] = asc[0]?.['cashAtBeginningOfPeriod'];
      sum['cashAtEndOfPeriod'] = asc[3]?.['cashAtEndOfPeriod'];
      aCash.set(String(r['date']), fill(r, sum, key));
    } else {
      const inc = aIncome.get(String(r['date'])) ?? aIncome.values().next().value;
      const begin = i(c.revenueQ * c.assetsToRevenueQ * 0.05 * (1 + 0.1 * sym(key)));
      aCash.set(String(r['date']), fill(r, cashflowModel(inc as Row, begin, key), key));
    }
  }

  return {
    income: { annual: orderLike(old.income.annual, aIncome), quarter: orderLike(old.income.quarter, qIncome) },
    balance: { annual: orderLike(old.balance.annual, aBalance), quarter: orderLike(old.balance.quarter, qBalance) },
    cashflow: { annual: orderLike(old.cashflow.annual, aCash), quarter: orderLike(old.cashflow.quarter, qCash) },
  };
}

/** TTM (last four quarters) from the synthetic income statement, for ratios and metrics. */
function ttmOf(incomeQuarters: Row[]) {
  const last4 = [...incomeQuarters].sort((a, b) => String(b['date']).localeCompare(String(a['date']))).slice(0, 4);
  const sum = (k: string) => last4.reduce((a, r) => a + (r[k] as number), 0);
  const shares = (last4[0]?.['weightedAverageShsOut'] as number) ?? 1;
  return {
    revenue: sum('revenue'),
    gross: sum('grossProfit'),
    operating: sum('operatingIncome'),
    ebitda: sum('ebitda'),
    ibt: sum('incomeBeforeTax'),
    tax: sum('incomeTaxExpense'),
    net: sum('netIncome'),
    shares,
  };
}

// ───────────────────────────── prices ─────────────────────────────

/** A random walk of closes for `n` bars, oldest first, ending near `last`. */
function walk(n: number, last: number, key: string, stepPct = 0.012): number[] {
  const out = new Array<number>(n);
  let p = last;
  for (let k = n - 1; k >= 0; k--) {
    out[k] = p;
    p = p / (1 + stepPct * sym(`${key}:${k}`));
  }
  return out;
}

const r2 = (v: number) => round(v, 2);

/** OHLC rows for the dates of `old` (any order), consistent within each bar. */
function bars(old: Row[], last: number, key: string, stepPct: number): Row[] {
  const order = old.map((r, idx) => ({ r, idx })).sort((a, b) => String(a.r['date']).localeCompare(String(b.r['date'])));
  const closes = walk(order.length, last, key, stepPct);
  const made = new Array<Row>(old.length);
  order.forEach(({ r, idx }, k) => {
    const rk = `${key}:${r['date']}`;
    const close = r2(closes[k] as number);
    const prev = k > 0 ? r2(closes[k - 1] as number) : r2(close / (1 + stepPct * sym(`${rk}:prev`)));
    const open = r2(prev * (1 + (stepPct / 3) * sym(`${rk}:open`)));
    const high = r2(Math.max(open, close) * (1 + stepPct * 0.5 * u(`${rk}:hi`)));
    const low = r2(Math.min(open, close) * (1 - stepPct * 0.5 * u(`${rk}:lo`)));
    const out: Row = {};
    for (const [field, v] of Object.entries(r)) {
      if (typeof v !== 'number') out[field] = v;
      else if (field === 'open') out[field] = open;
      else if (field === 'high') out[field] = high;
      else if (field === 'low') out[field] = low;
      else if (field === 'close') out[field] = close;
      else if (field === 'vwap') out[field] = round((open + high + low + close) / 4, 3);
      else if (field === 'change') out[field] = round(close - prev, 4);
      else if (field === 'changePercent') out[field] = round(((close - prev) / prev) * 100, 5);
      else if (field === 'volume') {
        const vol = 2e5 * (1 + 4 * u(`${rk}:vol`)) * (stepPct > 0.005 ? 40 : 1);
        out[field] = Number.isInteger(v) ? Math.round(vol) : round(vol + 0.123456, 6); // keep FMP's fractional volume where it was
      } else out[field] = generic(v, `${rk}:${field}`);
    }
    made[idx] = out;
  });
  return made;
}

function quote(old: Row, symbol: string, key: string): Row {
  const c = COMPANIES[symbol];
  const price = c ? c.price : 100;
  const change = r2(price * 0.012 * sym(`${key}:chg`));
  const prev = r2(price - change);
  const open = r2(prev * (1 + 0.004 * sym(`${key}:open`)));
  const values: Row = {
    price,
    change,
    previousClose: prev,
    changePercentage: round((change / prev) * 100, 5),
    open,
    dayHigh: r2(Math.max(open, price) * (1 + 0.006 * u(`${key}:hi`))),
    dayLow: r2(Math.min(open, price) * (1 - 0.006 * u(`${key}:lo`))),
    yearHigh: r2(price * (1.15 + 0.2 * u(`${key}:yh`))),
    yearLow: r2(price * (0.6 + 0.2 * u(`${key}:yl`))),
    priceAvg50: round(price * (1 + 0.03 * sym(`${key}:a50`)), 4),
    priceAvg200: round(price * (1 + 0.08 * sym(`${key}:a200`)), 4),
    marketCap: Math.round(price * (c ? c.shares : 1e9)),
    volume: Math.round(1e7 * (1 + 4 * u(`${key}:vol`))),
  };
  const out: Row = {};
  for (const [k, v] of Object.entries(old)) {
    if (k === 'timestamp' || typeof v !== 'number') out[k] = v;
    else out[k] = k in values ? values[k] : generic(v, `${key}:${k}`);
  }
  return out;
}

function profile(old: Row, symbol: string, key: string): Row {
  const q = quote({ price: 0, change: 0, changePercentage: 0, volume: 0, marketCap: 0, yearHigh: 0, yearLow: 0 }, symbol, key);
  const out: Row = {};
  for (const [k, v] of Object.entries(old)) {
    if (k === 'price' || k === 'change' || k === 'changePercentage' || k === 'volume' || k === 'marketCap') out[k] = q[k];
    else if (k === 'range') out[k] = `${q['yearLow']}-${q['yearHigh']}`;
    else if (k === 'averageVolume') out[k] = Math.round(1.1e7 * (1 + 3 * u(`${key}:avgvol`)));
    else if (k === 'beta') out[k] = round(0.6 + 1.2 * u(`${key}:beta`), 3);
    else if (k === 'lastDividend') out[k] = v === 0 ? 0 : round(0.2 + 3 * u(`${key}:div`), 2);
    else if (k === 'description') out[k] = `Synthetic test profile for ${symbol}. This text is not a real company description, and the numbers in this file are not real market data.`;
    else if (k === 'ceo') out[k] = v === null || v === '' ? v : 'Test CEO';
    else if (k === 'phone') out[k] = v === null || v === '' ? v : '+1 555 0100';
    else if (k === 'address') out[k] = v === null || v === '' ? v : '1 Example Street';
    else if (k === 'image') out[k] = `https://example.com/logo/${symbol}.png`;
    else if (k === 'fullTimeEmployees') out[k] = v === null || v === '' ? v : String(1000 * Math.round(5 + 195 * u(`${key}:emp`)));
    else out[k] = typeof v === 'number' ? generic(v, `${key}:${k}`) : v;
  }
  return out;
}

// ───────────────────────────── files ─────────────────────────────

interface Wrapper {
  status: number;
  body: unknown;
  [k: string]: unknown;
}

function readWrapper(file: string): { w: Wrapper; bodyIsString: boolean; data: unknown } {
  const w = JSON.parse(readFileSync(file, 'utf8')) as Wrapper;
  const bodyIsString = typeof w.body === 'string';
  let data: unknown = w.body;
  if (bodyIsString) {
    try {
      data = JSON.parse(w.body as string);
    } catch {
      data = w.body; // plain text (an error body)
    }
  }
  return { w, bodyIsString, data };
}

function writeWrapper(file: string, w: Wrapper, bodyIsString: boolean, data: unknown): void {
  const out: Wrapper = { ...w, synthetic: true, body: bodyIsString ? JSON.stringify(data, null, 2) : data };
  // Keep `body` last, as in the recorded files.
  const { body, ...rest } = out;
  writeFileSync(file, `${JSON.stringify({ ...rest, body }, null, 2)}\n`);
}

function walkDir(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkDir(p) : p.endsWith('.json') ? [p] : [];
  });
}

const symbolOf = (rows: Row[], fallback: string) => String(rows[0]?.['symbol'] ?? fallback).toUpperCase();
const changed: string[] = [];
const kept: string[] = [];

/** Minutes after midnight of an FMP intraday `date` ("YYYY-MM-DD HH:MM:SS"). */
function minuteOf(date: string): number {
  const [h, m] = date.slice(11, 16).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Coarser bars built from synthetic 5min bars, for the dates of `old` (a 15min or 1hour
 * response of the same days). Real FMP data has this property, and a test relies on it:
 * an hourly bar's volume is the sum of its twelve 5min bars.
 */
function aggregate(old: Row[], five: Row[], spanMin: number): Row[] {
  return old.map((r) => {
    const day = String(r['date']).slice(0, 10);
    const start = minuteOf(String(r['date']));
    const parts = five
      .filter((b) => String(b['date']).slice(0, 10) === day && minuteOf(String(b['date'])) >= start && minuteOf(String(b['date'])) < start + spanMin)
      .sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
    if (parts.length === 0) throw new Error(`no 5min bars for ${r['date']}`);
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'open') out[k] = parts[0]?.['open'];
      else if (k === 'close') out[k] = parts.at(-1)?.['close'];
      else if (k === 'high') out[k] = Math.max(...parts.map((b) => b['high'] as number));
      else if (k === 'low') out[k] = Math.min(...parts.map((b) => b['low'] as number));
      else if (k === 'volume') out[k] = parts.reduce((a, b) => a + (b['volume'] as number), 0);
      else out[k] = v;
    }
    return out;
  });
}

const SPAN_MIN: Record<string, number> = { '15min': 15, '1hour': 60 };

function market(): void {
  // 5min bars first: the 15min and 1hour responses of the same days are built from them.
  const fiveBySuffix = new Map<string, Row[]>();
  for (const file of walkDir(MARKET).filter((f) => basename(f).startsWith('chart-5min-'))) {
    const { data } = readWrapper(file);
    const suffix = basename(file).replace(/^chart-5min-/, '');
    fiveBySuffix.set(suffix, bars(data as Row[], COMPANIES['AAPL']?.price ?? 100, `market:${relative(MARKET, file)}`, 0.0015));
  }

  for (const file of walkDir(MARKET).sort()) {
    const name = relative(MARKET, file);
    if (name.endsWith('.summary.json')) {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Row;
      const [newest, oldest] = bars([s['newest'] as Row, s['oldest'] as Row], company('AAPL').price, `summary:${name}`, 0.012);
      // Twenty years apart: put the oldest bar far below the newest, as a long history would.
      const old2 = { ...(oldest as Row) };
      for (const k of ['open', 'high', 'low', 'close', 'vwap', 'change']) old2[k] = round((old2[k] as number) / 40, 4);
      s['newest'] = newest;
      s['oldest'] = old2;
      s['note'] = 'Shape of one capped FMP response (GET historical-price-eod/full?symbol=AAPL&from=1980-01-01&to=2026-10-02): its row count, order, keys and end dates. The two rows hold SYNTHETIC values.';
      s['synthetic'] = true;
      writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
      changed.push(name);
      continue;
    }
    const { w, bodyIsString, data } = readWrapper(file);
    const base = basename(file);
    if (w.status !== 200 || !Array.isArray(data) || data.length === 0 || /^search-|^splits-/.test(base)) {
      kept.push(name);
      continue;
    }
    const rows = data as Row[];
    const symbol = symbolOf(rows, (/-(AAPL|MSFT|JPM|TSM|RIVN|NVDA)\b/i.exec(base)?.[1] ?? 'AAPL').toUpperCase());
    const key = `market:${name}`;
    let made: Row[];
    const coarse = /^chart-(15min|1hour)-(.*)$/.exec(base);
    const five = coarse ? fiveBySuffix.get(coarse[2] ?? '') : undefined;
    if (coarse && five) {
      made = aggregate(rows, five, SPAN_MIN[coarse[1] ?? ''] ?? 60);
    } else if (base.startsWith('chart-5min-')) {
      made = fiveBySuffix.get(base.replace(/^chart-5min-/, '')) as Row[];
    } else if (/^(eod-|chart-)/.test(base)) {
      const intraday = base.startsWith('chart-');
      made = bars(rows, COMPANIES[symbol]?.price ?? 100, key, intraday ? 0.0015 : 0.012);
    } else if (base.startsWith('quote-short')) {
      made = rows.map((r) => {
        const q = quote({ price: 0, change: 0, volume: 0 }, symbol, key);
        return { ...r, price: q['price'], change: q['change'], volume: q['volume'] };
      });
    } else if (base.startsWith('quote-')) {
      made = rows.map((r) => quote(r, symbol, key));
    } else if (base.startsWith('profile-')) {
      made = rows.map((r) => profile(r, symbol, key));
    } else {
      throw new Error(`no rule for market fixture ${name}`);
    }
    writeWrapper(file, w, bodyIsString, made);
    changed.push(name);
  }
}

function fundamentals(): void {
  for (const symbol of readdirSync(FUND).filter((d) => !d.startsWith('_') && statSync(join(FUND, d)).isDirectory()).sort()) {
    const dir = join(FUND, symbol);
    const load = (n: string) => readWrapper(join(dir, `${n}.json`));
    const rowsOf = (n: string) => load(n).data as Row[];
    const old: StatementSet = {
      income: { annual: rowsOf('income-annual'), quarter: rowsOf('income-quarter') },
      balance: { annual: rowsOf('balance-annual'), quarter: rowsOf('balance-quarter') },
      cashflow: { annual: rowsOf('cashflow-annual'), quarter: rowsOf('cashflow-quarter') },
    };
    const made = synthesizeStatements(symbol, old);
    for (const st of ['income', 'balance', 'cashflow'] as const) {
      for (const p of ['annual', 'quarter'] as const) {
        const n = `${st}-${p}`;
        const { w, bodyIsString } = load(n);
        writeWrapper(join(dir, `${n}.json`), w, bodyIsString, made[st][p]);
        changed.push(`${symbol}/${n}.json`);
      }
    }

    const c = company(symbol);
    const ttm = ttmOf(made.income.quarter);
    const key = `fund:${symbol}`;
    const set = (n: string, f: (rows: Row[]) => Row[]) => {
      const { w, bodyIsString, data } = load(n);
      if (w.status !== 200 || !Array.isArray(data)) {
        kept.push(`${symbol}/${n}.json`);
        return;
      }
      writeWrapper(join(dir, `${n}.json`), w, bodyIsString, f(data as Row[]));
      changed.push(`${symbol}/${n}.json`);
    };

    set('profile', (rows) => rows.map((r) => profile(r, symbol, `${key}:profile`)));

    set('ratios-ttm', (rows) =>
      rows.map((r) => {
        const out = genericRow(r, `${key}:ratios`);
        const m = (v: number) => round(v, 6);
        const eps = ttm.net / ttm.shares;
        const modeled: Row = {
          grossProfitMarginTTM: m(ttm.gross / ttm.revenue),
          operatingProfitMarginTTM: m(ttm.operating / ttm.revenue),
          ebitMarginTTM: m(ttm.operating / ttm.revenue),
          ebitdaMarginTTM: m(ttm.ebitda / ttm.revenue),
          pretaxProfitMarginTTM: m(ttm.ibt / ttm.revenue),
          continuousOperationsProfitMarginTTM: m(ttm.net / ttm.revenue),
          netProfitMarginTTM: m(ttm.net / ttm.revenue),
          bottomLineProfitMarginTTM: m(ttm.net / ttm.revenue),
          netIncomePerShareTTM: m(eps),
          revenuePerShareTTM: m(ttm.revenue / ttm.shares),
          effectiveTaxRateTTM: ttm.ibt > 0 ? m(ttm.tax / ttm.ibt) : 0,
          // Price in the reporting currency over EPS; negative for a company with losses.
          priceToEarningsRatioTTM: m((c.price * c.fx) / eps),
          priceToEarningsDilutedRatioTTM: m((c.price * c.fx) / eps),
        };
        for (const [k, v] of Object.entries(modeled)) if (typeof r[k] === 'number' && r[k] !== 0) out[k] = v;
        return out;
      }),
    );
    set('key-metrics-ttm', (rows) => rows.map((r) => ({ ...genericRow(r, `${key}:km`), marketCap: Math.round(c.price * c.shares) })));
    set('financial-scores', (rows) =>
      rows.map((r) => {
        const out = genericRow(r, `${key}:scores`);
        const bal = [...made.balance.quarter].sort((a, b) => String(b['date']).localeCompare(String(a['date'])))[0] as Row;
        const losing = ttm.net < 0;
        const modeled: Row = {
          altmanZScore: round(losing ? 0.8 + 1.2 * u(`${key}:z`) : 2.5 + 6 * u(`${key}:z`), 6),
          piotroskiScore: losing ? 1 + Math.floor(3 * u(`${key}:f`)) : 5 + Math.floor(5 * u(`${key}:f`)),
          workingCapital: (bal['totalCurrentAssets'] as number) - (bal['totalCurrentLiabilities'] as number),
          totalAssets: bal['totalAssets'],
          totalLiabilities: bal['totalLiabilities'],
          ebit: ttm.operating,
          revenue: ttm.revenue,
          marketCap: Math.round(c.price * c.shares),
        };
        for (const [k, v] of Object.entries(modeled)) if (typeof r[k] === 'number') out[k] = v;
        return out;
      }),
    );
    set('grades-consensus', (rows) => rows.map((r) => genericRow(r, `${key}:grades`)));
    set('price-target-consensus', (rows) =>
      rows.map((r) => {
        const mid = r2(c.price * (1.05 + 0.15 * u(`${key}:pt`)));
        return { ...r, targetConsensus: mid, targetMedian: r2(mid * 1.01), targetHigh: r2(mid * 1.35), targetLow: r2(mid * 0.7) };
      }),
    );
    set('earnings', (rows) => {
      const asc = [...rows].map((r, idx) => ({ r, idx })).sort((a, b) => String(a.r['date']).localeCompare(String(b.r['date'])));
      const out = new Array<Row>(rows.length);
      const epsBase = (c.revenueQ * (c.lender ? 0.25 : c.grossMargin - c.rd - c.sga) * (1 - c.tax)) / c.shares;
      asc.forEach(({ r, idx }, k) => {
        const rk = `${key}:earn:${r['date']}`;
        const growth = 1 + 0.012 * (k - asc.length);
        const epsEst = r2(epsBase * Math.max(0.05, growth) * (1 + 0.03 * sym(`${rk}:e`)));
        const revEst = Math.round(c.revenueQ * Math.max(0.05, growth) * (1 + 0.03 * sym(`${rk}:r`)));
        const o: Row = { ...r };
        if (typeof r['epsEstimated'] === 'number') o['epsEstimated'] = epsEst;
        if (typeof r['epsActual'] === 'number') o['epsActual'] = r2(epsEst * (1 + 0.08 * sym(`${rk}:ea`) + 0.02));
        if (typeof r['revenueEstimated'] === 'number') o['revenueEstimated'] = revEst;
        if (typeof r['revenueActual'] === 'number') o['revenueActual'] = Math.round(revEst * (1 + 0.03 * sym(`${rk}:ra`) + 0.005));
        out[idx] = o;
      });
      return out;
    });
  }
}

market();
fundamentals();
console.log(`synthetic: ${changed.length} files`);
console.log(`unchanged (error bodies, empty answers, splits, search listings): ${kept.length} files`);
for (const k of kept) console.log(`  kept ${k}`);
