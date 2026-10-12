/**
 * Synthetic fundamentals provider: offline development and every test that needs a
 * server without credentials. Nothing here is real company data.
 *
 * It obeys the same invariants as the FMP provider (invariant 10):
 *   - Deterministic per symbol. The numbers are a pure function of the symbol and fixed
 *     anchors; only `asOf` follows the clock (injectable). No `Math.random`, no `Date.now`
 *     inside the model.
 *   - Flows are built quarter by quarter from integer arithmetic, and each annual row is
 *     the exact SUM of its four quarters, so identities (gross profit = revenue - cost
 *     of revenue, net income = pre-tax income - tax) hold for the year too.
 *   - Balance-sheet fiscal-year lines are COPIES of the Q4 row. Quarters are never summed.
 *   - EPS is NOT summed: the annual EPS is annual net income over the average share count,
 *     like a real filing, so it differs slightly from the sum of the four quarters.
 *   - Fiscal labels follow the symbol's own fiscal year end (December, March, June or
 *     September), not the calendar. Rows are newest first.
 *   - Size follows the synthetic market engine: market cap is the engine's base price times
 *     its average daily dollar volume times a seeded factor, so a bigger-trading symbol is
 *     a bigger company, and P/E, P/S and yields are computed against that same price.
 *   - ETFs have no financial statements: overview sections are `unavailable`, statements
 *     and earnings are empty. A symbol outside the universe is unknown.
 *   - News is seeded per symbol and New York day, so an article keeps its time and title
 *     as the window moves. Only which days fall in the window follows the clock. Every
 *     article says it is synthetic, and none has a link: there is no page to open.
 */
import type {
  EarningsEvent,
  EarningsResponse,
  FundamentalsOverview,
  NewsArticle,
  NewsResponse,
  StatementKind,
  StatementPeriod,
  StatementRow,
  StatementsResponse,
} from '@shared/types';
import { dayToCivil, nyDayOf, nyWallToUnix, weekdayOf } from '../../market/calendar';
import { UNIVERSE } from '../../market/universe';
import type { SymbolModel } from '../../market/universe';
import { UnknownSymbolError } from '../../market/types';
import { LINE_ITEMS, MAX_STATEMENT_ROWS, lineItemsFor } from '../lineItems';
import { finishNews, newsWindow } from '../news';
import type { FundamentalsProvider } from '../types';
import { SECTORS } from './sectors';

/** Latest reported quarter end. Fixed, so the output never drifts with the clock. */
const LATEST_QUARTER_END = { year: 2026, month: 6 };
/** Quarters generated: 11 fiscal years plus the partial one. */
const QUARTERS = 47;
const CURRENCY = 'USD';
const FY_END_MONTHS = [12, 12, 12, 12, 9, 6, 3] as const;

type Lines = Record<string, number>;

interface QuarterRec {
  /** 0 is the latest quarter. */
  index: number;
  periodEnd: string;
  fiscalYear: number;
  fiscalPeriod: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  income: Lines;
  balance: Lines;
  cashflow: Lines;
  epsEstimate: number;
  revenueEstimate: number;
}

interface Company {
  model: SymbolModel;
  marketCap: number;
  growth: number;
  taxRate: number;
  quarters: QuarterRec[]; // newest first
  nextEps: number;
  nextRevenue: number;
}

// ───────────────────────────── helpers ─────────────────────────────

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, uniform in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = Math.round;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const range = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Last day of month `month` (1-12) of `year`, as epoch ms at 00:00 UTC. */
function monthEndMs(year: number, month: number): number {
  return Date.UTC(year, month, 0);
}

function quarterEnd(index: number): { year: number; month: number; ms: number } {
  const total = LATEST_QUARTER_END.year * 12 + (LATEST_QUARTER_END.month - 1) - 3 * index;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, ms: monthEndMs(year, month) };
}

/** The issuer's fiscal year is named after the calendar year in which it ENDS. */
function fiscalLabel(year: number, month: number, fyEndMonth: number): { fiscalYear: number; fiscalPeriod: 'Q1' | 'Q2' | 'Q3' | 'Q4' } {
  const fiscalYear = month <= fyEndMonth ? year : year + 1;
  const q = Math.floor(((month - fyEndMonth + 11) % 12) / 3) + 1;
  return { fiscalYear, fiscalPeriod: `Q${q}` as 'Q1' | 'Q2' | 'Q3' | 'Q4' };
}

const DAY_MS = 86_400_000;
const sum = (rows: readonly Lines[], key: string): number => rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);

// ───────────────────────────── the model ─────────────────────────────

function buildCompany(model: SymbolModel): Company {
  const r = rng(hash32(model.symbol));
  const price = model.basePrice;
  const marketCap = round(price * model.avgDailyVolume * range(r, 40, 100));
  const sharesNow = marketCap / price;

  // Per-symbol business profile.
  const growth = range(r, -0.02, 0.16);
  const priceToSales = range(r, 1.5, 9);
  const rdRatio = range(r, 0.01, 0.14);
  const sgaRatio = range(r, 0.06, 0.2);
  const opMargin = range(r, 0.07, 0.3);
  const grossMargin = rdRatio + sgaRatio + opMargin;
  const interestRatio = range(r, 0.003, 0.02);
  const taxRate = range(r, 0.14, 0.25);
  const daRatio = range(r, 0.02, 0.07);
  const sbcRatio = range(r, 0.005, 0.05);
  const capexRatio = range(r, 0.025, 0.1);
  const buybackShare = range(r, 0, 0.7);
  const payout = r() < 0.3 ? 0 : range(r, 0.1, 0.45);
  const shareDrift = range(r, -0.003, 0.005);
  const season = [range(r, 0.94, 1), range(r, 0.96, 1.02), range(r, 0.98, 1.04), range(r, 1, 1.1)];
  const assetsPerRevenue = range(r, 0.8, 2.4);
  const mix = {
    cash: range(r, 0.1, 0.25),
    recv: range(r, 0.04, 0.1),
    inv: range(r, 0, 0.08),
    ppe: range(r, 0.1, 0.3),
    goodwill: range(r, 0, 0.15),
    curLiab: range(r, 0.12, 0.25),
    stDebt: range(r, 0.01, 0.04),
    ltDebt: range(r, 0.03, 0.25),
    otherLiab: range(r, 0.03, 0.08),
  };
  const fyEndMonth = FY_END_MONTHS[Math.floor(r() * FY_END_MONTHS.length)] ?? 12;

  const baseQuarterRevenue = marketCap / priceToSales / 4;
  const firstEligible = model.listedAt * 1000 - 365 * DAY_MS;

  const quarters: QuarterRec[] = [];
  for (let i = 0; i < QUARTERS; i++) {
    // Fixed number of draws per quarter keeps every quarter independent of listing date.
    const jitter = Array.from({ length: 10 }, () => r() - 0.5);
    const estimateNoise = [r() - 0.5, r() - 0.5];
    const qe = quarterEnd(i);
    if (qe.ms < firstEligible) continue;

    const smooth = baseQuarterRevenue * Math.pow(1 + growth, -i / 4);
    const calendarQuarter = Math.floor((qe.month - 1) / 3);
    const rev = round(smooth * (season[calendarQuarter] ?? 1) * (1 + 0.02 * (jitter[0] ?? 0)));
    const cost = round(rev * (1 - grossMargin * (1 + 0.03 * (jitter[1] ?? 0))));
    const gp = rev - cost;
    const rd = round(rev * rdRatio * (1 + 0.1 * (jitter[2] ?? 0)));
    const sga = round(rev * sgaRatio * (1 + 0.1 * (jitter[3] ?? 0)));
    const opex = rd + sga;
    const opInc = gp - opex;
    const da = round(rev * daRatio);
    const interest = round(rev * interestRatio);
    const pbt = opInc - interest;
    const tax = round(pbt * taxRate);
    const ni = pbt - tax;
    const shares = round(sharesNow * Math.pow(1 + shareDrift, i));

    const sbc = round(rev * sbcRatio);
    const wc = round(rev * 0.04 * (jitter[4] ?? 0));
    const ocf = ni + da + sbc + wc;
    const capex = -round(rev * capexRatio * (1 + 0.15 * (jitter[5] ?? 0)));
    const fcf = ocf + capex;
    const buyback = -round(Math.max(0, fcf) * buybackShare);
    const dividends = -round(Math.max(0, ni) * payout);
    const investing = capex + round(rev * 0.02 * (jitter[6] ?? 0));
    const financing = buyback + dividends + round(rev * 0.02 * (jitter[7] ?? 0));

    const assets = round(smooth * 4 * assetsPerRevenue);
    const cashSti = round(assets * mix.cash * (1 + 0.1 * (jitter[8] ?? 0)));
    const recv = round(assets * mix.recv);
    const inv = round(assets * mix.inv);
    const curAssets = cashSti + recv + inv + round(assets * 0.03);
    const ppe = round(assets * mix.ppe);
    const goodwill = round(assets * mix.goodwill);
    const stDebt = round(assets * mix.stDebt);
    const ltDebt = round(assets * mix.ltDebt * (1 + 0.1 * (jitter[9] ?? 0)));
    const curLiab = round(assets * mix.curLiab);
    const liabilities = curLiab + ltDebt + round(assets * mix.otherLiab);
    const totalDebt = stDebt + ltDebt;

    const label = fiscalLabel(qe.year, qe.month, fyEndMonth);
    quarters.push({
      index: i,
      periodEnd: isoDate(qe.ms),
      ...label,
      income: {
        revenue: rev,
        costOfRevenue: cost,
        grossProfit: gp,
        researchAndDevelopmentExpenses: rd,
        sellingGeneralAndAdministrativeExpenses: sga,
        operatingExpenses: opex,
        operatingIncome: opInc,
        ebitda: opInc + da,
        interestExpense: interest,
        incomeBeforeTax: pbt,
        incomeTaxExpense: tax,
        netIncome: ni,
        epsDiluted: round2(ni / shares),
        weightedAverageShsOutDil: shares,
      },
      cashflow: {
        netIncome: ni,
        depreciationAndAmortization: da,
        stockBasedCompensation: sbc,
        changeInWorkingCapital: wc,
        operatingCashFlow: ocf,
        capitalExpenditure: capex,
        freeCashFlow: fcf,
        netCashProvidedByInvestingActivities: investing,
        commonStockRepurchased: buyback,
        netDividendsPaid: dividends,
        netCashProvidedByFinancingActivities: financing,
        netChangeInCash: ocf + investing + financing,
      },
      balance: {
        cashAndCashEquivalents: round(cashSti * 0.6),
        cashAndShortTermInvestments: cashSti,
        netReceivables: recv,
        inventory: inv,
        totalCurrentAssets: curAssets,
        propertyPlantEquipmentNet: ppe,
        goodwillAndIntangibleAssets: goodwill,
        totalAssets: assets,
        totalCurrentLiabilities: curLiab,
        shortTermDebt: stDebt,
        longTermDebt: ltDebt,
        totalDebt,
        netDebt: totalDebt - cashSti,
        totalLiabilities: liabilities,
        totalEquity: assets - liabilities,
      },
      epsEstimate: round2((ni / shares) * (1 + 0.1 * (estimateNoise[0] ?? 0))),
      revenueEstimate: round(rev * (1 + 0.04 * (estimateNoise[1] ?? 0))),
    });
  }

  const latest = quarters[0];
  const nextRevenue = latest ? round((latest.income.revenue ?? 0) * (1 + growth / 4)) : 0;
  const nextEps = latest ? round2((latest.income.epsDiluted ?? 0) * (1 + growth / 4)) : 0;
  return { model, marketCap, growth, taxRate, quarters, nextEps, nextRevenue };
}

// ───────────────────────────── statements ─────────────────────────────

function toRow(rec: QuarterRec, statement: StatementKind, lines: Lines, period: StatementRow['fiscalPeriod'], periodEnd: string, filingOffsetDays: number): StatementRow {
  const out: Record<string, number | null> = {};
  for (const { key } of LINE_ITEMS[statement]) out[key] = lines[key] ?? null;
  return {
    fiscalYear: rec.fiscalYear,
    fiscalPeriod: period,
    periodEnd,
    filingDate: isoDate(Date.parse(`${periodEnd}T00:00:00Z`) + filingOffsetDays * DAY_MS),
    reportedCurrency: CURRENCY,
    lines: out,
  };
}

function quarterlyRows(co: Company, statement: StatementKind): StatementRow[] {
  return co.quarters.map((q) => toRow(q, statement, q[statement], q.fiscalPeriod, q.periodEnd, 30));
}

/** Annual rows: complete fiscal years only (all of Q1..Q4 present). */
function annualRows(co: Company, statement: StatementKind): StatementRow[] {
  const byYear = new Map<number, QuarterRec[]>();
  for (const q of co.quarters) byYear.set(q.fiscalYear, [...(byYear.get(q.fiscalYear) ?? []), q]);

  const rows: StatementRow[] = [];
  for (const [, qs] of byYear) {
    if (new Set(qs.map((q) => q.fiscalPeriod)).size !== 4) continue;
    const q4 = qs.find((q) => q.fiscalPeriod === 'Q4');
    if (!q4) continue;

    let lines: Lines;
    if (statement === 'balance') {
      // A stock: the fiscal-year value IS the year-end value. Never a sum.
      lines = { ...q4.balance };
    } else {
      const parts = qs.map((q) => q[statement]);
      lines = {};
      for (const { key } of LINE_ITEMS[statement]) lines[key] = sum(parts, key);
      if (statement === 'income') {
        // EPS is not a flow: net income over the average share count, like a filing.
        const shares = round(sum(parts, 'weightedAverageShsOutDil') / parts.length);
        lines.weightedAverageShsOutDil = shares;
        lines.epsDiluted = round2((lines.netIncome ?? 0) / shares);
      }
    }
    rows.push(toRow(q4, statement, lines, 'FY', q4.periodEnd, 45));
  }
  return rows;
}

// ───────────────────────────── news ─────────────────────────────

const NEWS_HEADLINES: readonly ((name: string) => string)[] = [
  (n) => `${n} shares move with the broader market`,
  (n) => `What analysts watch in ${n}'s next report`,
  (n) => `${n} options activity rises before the close`,
  (n) => `${n} in focus as sector peers report`,
  (n) => `Three questions for ${n} management this quarter`,
  (n) => `${n} trading volume above its monthly average`,
];
const NEWS_PUBLISHERS = ['Synthetic Wire', 'Sample Markets Daily', 'Placeholder Business News'] as const;

/** The seeded articles of one New York day. Weekdays have more news than weekends. */
function newsOfDay(model: SymbolModel, day: number): NewsArticle[] {
  const r = rng(hash32(`${model.symbol}|news|${day}`));
  const weekend = weekdayOf(day) >= 5;
  const perDay = model.type === 'CS' ? (weekend ? 1 : 3) : 1;
  const count = Math.floor(r() * (perDay + 1));
  const { year, month, day: dom } = dayToCivil(day);
  const out: NewsArticle[] = [];
  for (let i = 0; i < count; i++) {
    // 06:00 to 20:00 New York, to the minute.
    const second = (6 * 60 + Math.floor(r() * 14 * 60)) * 60;
    const headline = NEWS_HEADLINES[Math.floor(r() * NEWS_HEADLINES.length)] ?? NEWS_HEADLINES[0]!;
    out.push({
      publishedAt: nyWallToUnix(day, second),
      title: headline(model.name),
      summary: `Synthetic article for ${model.symbol}, ${year}-${pad(month)}-${pad(dom)}. It is generated for offline development and is not real news.`,
      publisher: NEWS_PUBLISHERS[Math.floor(r() * NEWS_PUBLISHERS.length)] ?? null,
      site: null,
      url: null,
    });
  }
  return out;
}

// ───────────────────────────── the provider ─────────────────────────────

export interface SyntheticFundamentalsOptions {
  /** Milliseconds since the epoch, for `asOf` only. */
  now?: () => number;
}

/** Synthetic stand-in for the FMP evidence: banks and broker-dealers are lenders. */
function lenderIndustry(industry: string | null): boolean {
  return industry !== null && (industry.startsWith('Banks') || industry === 'Capital Markets');
}

export class SyntheticFundamentalsProvider implements FundamentalsProvider {
  readonly available = true;
  private readonly now: () => number;
  private readonly companies = new Map<string, Company>();

  constructor(opts: SyntheticFundamentalsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  getOverview(symbol: string): Promise<FundamentalsOverview> {
    return this.run(symbol, (model) => this.overview(model));
  }

  getStatements(symbol: string, statement: StatementKind, period: StatementPeriod): Promise<StatementsResponse> {
    return this.run(symbol, (model) => {
      const co = model.type === 'CS' ? this.company(model) : null;
      const all = !co ? [] : period === 'annual' ? annualRows(co, statement) : quarterlyRows(co, statement);
      const rows = all.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)).slice(0, MAX_STATEMENT_ROWS[period]);
      return { symbol: model.symbol, statement, period, lineItems: lineItemsFor(statement), rows };
    });
  }

  getEarnings(symbol: string): Promise<EarningsResponse> {
    return this.run(symbol, (model) => {
      const co = model.type === 'CS' ? this.company(model) : null;
      if (!co) return { symbol: model.symbol, events: [] };
      const reported: EarningsEvent[] = co.quarters.map((q) => ({
        date: isoDate(Date.parse(`${q.periodEnd}T00:00:00Z`) + 30 * DAY_MS),
        epsActual: q.income.epsDiluted ?? null,
        epsEstimate: q.epsEstimate,
        revenueActual: q.income.revenue ?? null,
        revenueEstimate: q.revenueEstimate,
      }));
      // The next report: not yet filed, so no actuals.
      const next = quarterEnd(-1);
      const upcoming: EarningsEvent = {
        date: isoDate(next.ms + 30 * DAY_MS),
        epsActual: null,
        epsEstimate: co.nextEps,
        revenueActual: null,
        revenueEstimate: co.nextRevenue,
      };
      return { symbol: model.symbol, events: [upcoming, ...reported] };
    });
  }

  getNews(symbol: string): Promise<NewsResponse> {
    return this.run(symbol, (model) => {
      const nowMs = this.now();
      const window = newsWindow(nowMs);
      const articles: NewsArticle[] = [];
      const first = nyDayOf(window.fromSeconds);
      for (let day = nyDayOf(Math.floor(nowMs / 1000)); day >= first; day--) articles.push(...newsOfDay(model, day));
      // finishNews drops today's articles that are later than now.
      return finishNews(model.symbol, window, nowMs, articles, false);
    });
  }

  private run<T>(symbol: string, body: (model: SymbolModel) => T): Promise<T> {
    const model = UNIVERSE.find((m) => m.symbol === symbol.trim().toUpperCase());
    if (!model) return Promise.reject(new UnknownSymbolError(symbol));
    try {
      return Promise.resolve(body(model));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private company(model: SymbolModel): Company {
    let co = this.companies.get(model.symbol);
    if (!co) {
      co = buildCompany(model);
      this.companies.set(model.symbol, co);
    }
    return co;
  }

  private overview(model: SymbolModel): FundamentalsOverview {
    const co = model.type === 'CS' ? this.company(model) : null;
    const [sector, industry] = SECTORS[model.symbol] ?? [null, null];
    // A fresh stream per call: the overview must not depend on how often it was asked.
    const r = rng(hash32(`${model.symbol}|overview`));
    const nullMetrics: FundamentalsOverview['metrics'] = {
      peRatio: null, priceToSales: null, priceToBook: null, evToEbitda: null, pegRatio: null,
      grossMargin: null, operatingMargin: null, netMargin: null, returnOnEquity: null,
      returnOnAssets: null, returnOnInvestedCapital: null, debtToEquity: null, currentRatio: null,
      interestCoverage: null, epsDiluted: null, revenuePerShare: null, freeCashFlowPerShare: null,
      bookValuePerShare: null, dividendYield: null, payoutRatio: null,
    };
    const nullAnalyst: FundamentalsOverview['analyst'] = {
      targetHigh: null, targetLow: null, targetConsensus: null, targetMedian: null,
      strongBuy: null, buy: null, hold: null, sell: null, strongSell: null, consensus: null,
    };

    const base = {
      reportedCurrency: CURRENCY,
      asOf: Math.floor(this.now() / 1000),
      // The synthetic statements do not model a lender's interest-heavy cost of revenue,
      // so the industry stands in for that evidence here. The FMP provider measures it.
      grossMarginNotMeaningful: lenderIndustry(industry),
    };
    const profile: FundamentalsOverview['profile'] = {
      symbol: model.symbol,
      name: model.name,
      exchange: model.exchange === 'XNAS' ? 'NASDAQ' : model.exchange === 'XNYS' ? 'NYSE' : model.exchange,
      sector,
      industry,
      country: 'US',
      website: null,
      description: `${model.name} is a synthetic listing. Its profile and figures are generated for development and are not real.`,
      ceo: null,
      employees: null,
      ipoDate: isoDate(model.listedAt * 1000),
      currency: CURRENCY,
      marketCap: null,
    };

    const ttmRows = co?.quarters.slice(0, 4) ?? [];
    const latest = co?.quarters[0];
    if (!co || !latest || ttmRows.length < 4) {
      return {
        ...base,
        profile,
        metrics: nullMetrics,
        scores: { piotroskiScore: null, altmanZScore: null },
        analyst: nullAnalyst,
        unavailable: ['metrics', 'scores', 'analyst'],
      };
    }

    const inc = ttmRows.map((q) => q.income);
    const cf = ttmRows.map((q) => q.cashflow);
    const revenue = sum(inc, 'revenue');
    const netIncome = sum(inc, 'netIncome');
    const operating = sum(inc, 'operatingIncome');
    const interest = sum(inc, 'interestExpense');
    const bal = latest.balance;
    const shares = latest.income.weightedAverageShsOutDil ?? 1;
    const equity = bal.totalEquity ?? 1;
    const price = model.basePrice;
    const mcap = co.marketCap;
    const dividends = Math.abs(sum(cf, 'netDividendsPaid'));
    const investedCapital = equity + (bal.totalDebt ?? 0);

    profile.marketCap = mcap;
    profile.employees = round(revenue / range(r, 300_000, 1_000_000));

    const price1 = (v: number) => round4(v);
    const metrics: FundamentalsOverview['metrics'] = {
      peRatio: price1(mcap / netIncome),
      priceToSales: price1(mcap / revenue),
      priceToBook: price1(mcap / equity),
      evToEbitda: price1((mcap + (bal.netDebt ?? 0)) / sum(inc, 'ebitda')),
      pegRatio: co.growth > 0 ? price1(mcap / netIncome / (co.growth * 100)) : null,
      grossMargin: price1(sum(inc, 'grossProfit') / revenue),
      operatingMargin: price1(operating / revenue),
      netMargin: price1(netIncome / revenue),
      returnOnEquity: price1(netIncome / equity),
      returnOnAssets: price1(netIncome / (bal.totalAssets ?? 1)),
      returnOnInvestedCapital: price1((operating * (1 - co.taxRate)) / investedCapital),
      debtToEquity: price1((bal.totalDebt ?? 0) / equity),
      currentRatio: price1((bal.totalCurrentAssets ?? 0) / (bal.totalCurrentLiabilities ?? 1)),
      interestCoverage: price1(operating / interest),
      epsDiluted: round2(netIncome / shares),
      revenuePerShare: round2(revenue / shares),
      freeCashFlowPerShare: round2(sum(cf, 'freeCashFlow') / shares),
      bookValuePerShare: round2(equity / shares),
      dividendYield: price1(dividends / mcap),
      payoutRatio: price1(dividends / netIncome),
    };

    const strongBuy = round(range(r, 0, 12));
    const buy = round(range(r, 5, 35));
    const hold = round(range(r, 2, 25));
    const sell = round(range(r, 0, 6));
    const strongSell = round(range(r, 0, 2));
    const total = strongBuy + buy + hold + sell + strongSell;
    const score = (2 * strongBuy + buy - sell - 2 * strongSell) / total;
    const consensusPrice = round2(price * range(r, 0.9, 1.3));
    return {
      ...base,
      profile,
      metrics,
      scores: { piotroskiScore: Math.floor(range(r, 3, 10)), altmanZScore: round2(range(r, 1.2, 7.5)) },
      analyst: {
        targetHigh: round2(consensusPrice * 1.2),
        targetLow: round2(consensusPrice * 0.8),
        targetConsensus: consensusPrice,
        targetMedian: round2(consensusPrice * range(r, 0.98, 1.02)),
        strongBuy,
        buy,
        hold,
        sell,
        strongSell,
        consensus: score >= 1.2 ? 'Strong Buy' : score >= 0.4 ? 'Buy' : score > -0.4 ? 'Hold' : 'Sell',
      },
      unavailable: [],
    };
  }
}
