/**
 * Data for the fundamentals mock: recorded FMP responses mapped to the contract types.
 *
 * ISOLATED ON PURPOSE. At integration the orchestrator replaces this module's body with
 * the output of the real server mapper (server/fundamentals). `mocks/fundamentals.ts`
 * only depends on the three functions exported here.
 *
 * Units were checked against the recorded responses: margins, yields, payout and
 * returns are already fractions (AAPL grossProfitMarginTTM 0.4865).
 */
import type {
  AnalystConsensus,
  EarningsResponse,
  FinancialScores,
  FundamentalsOverview,
  KeyMetricsTTM,
  StatementKind,
  StatementPeriod,
  StatementRow,
  StatementsResponse,
} from '@shared/types';

type Json = Record<string, unknown>;
interface Recorded {
  status: number;
  fetchedAt: string;
  body: Json[];
}

const files = import.meta.glob<Recorded>('../server/fundamentals/__fixtures__/fmp/*/*.json', {
  eager: true,
  import: 'default',
});

function recorded(symbol: string, name: string): Recorded | undefined {
  return files[`../server/fundamentals/__fixtures__/fmp/${symbol}/${name}.json`];
}
const first = (symbol: string, name: string): Json => recorded(symbol, name)?.body[0] ?? {};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export const MOCK_FUNDAMENTALS_SYMBOLS: readonly string[] = [
  ...new Set(Object.keys(files).map((p) => p.split('/').at(-2) ?? '')),
].filter((s) => s !== '' && !s.startsWith('_'));

export function hasFundamentals(symbol: string): boolean {
  return MOCK_FUNDAMENTALS_SYMBOLS.includes(symbol);
}

export function overviewFor(symbol: string): FundamentalsOverview {
  const p = first(symbol, 'profile');
  const r = first(symbol, 'ratios-ttm');
  const k = first(symbol, 'key-metrics-ttm');
  const sc = first(symbol, 'financial-scores');
  const g = first(symbol, 'grades-consensus');
  const t = first(symbol, 'price-target-consensus');

  const metrics: KeyMetricsTTM = {
    peRatio: num(r.priceToEarningsRatioTTM),
    priceToSales: num(r.priceToSalesRatioTTM),
    priceToBook: num(r.priceToBookRatioTTM),
    evToEbitda: num(k.evToEBITDATTM),
    pegRatio: num(r.priceToEarningsGrowthRatioTTM),
    grossMargin: num(r.grossProfitMarginTTM),
    operatingMargin: num(r.operatingProfitMarginTTM),
    netMargin: num(r.netProfitMarginTTM),
    returnOnEquity: num(k.returnOnEquityTTM),
    returnOnAssets: num(k.returnOnAssetsTTM),
    returnOnInvestedCapital: num(k.returnOnInvestedCapitalTTM),
    debtToEquity: num(r.debtToEquityRatioTTM),
    currentRatio: num(r.currentRatioTTM),
    interestCoverage: num(r.interestCoverageRatioTTM),
    epsDiluted: num(r.netIncomePerShareTTM),
    revenuePerShare: num(r.revenuePerShareTTM),
    freeCashFlowPerShare: num(r.freeCashFlowPerShareTTM),
    bookValuePerShare: num(r.bookValuePerShareTTM),
    dividendYield: num(r.dividendYieldTTM),
    payoutRatio: num(r.dividendPayoutRatioTTM),
  };
  const scores: FinancialScores = {
    piotroskiScore: num(sc.piotroskiScore),
    altmanZScore: num(sc.altmanZScore),
  };
  const analyst: AnalystConsensus = {
    targetHigh: num(t.targetHigh),
    targetLow: num(t.targetLow),
    targetConsensus: num(t.targetConsensus),
    targetMedian: num(t.targetMedian),
    strongBuy: num(g.strongBuy),
    buy: num(g.buy),
    hold: num(g.hold),
    sell: num(g.sell),
    strongSell: num(g.strongSell),
    consensus: str(g.consensus),
  };
  const employees = Number(p.fullTimeEmployees);
  const fetchedAt = Date.parse(recorded(symbol, 'profile')?.fetchedAt ?? '');
  return {
    profile: {
      symbol,
      name: str(p.companyName) ?? symbol,
      exchange: str(p.exchange),
      sector: str(p.sector),
      industry: str(p.industry),
      country: str(p.country),
      website: str(p.website),
      description: str(p.description),
      ceo: str(p.ceo),
      employees: Number.isFinite(employees) && employees > 0 ? employees : null,
      ipoDate: str(p.ipoDate),
      currency: str(p.currency) ?? 'USD',
      marketCap: num(p.marketCap),
    },
    metrics,
    scores,
    analyst,
    reportedCurrency: str(sc.reportedCurrency) ?? str(first(symbol, 'income-annual').reportedCurrency) ?? 'USD',
    asOf: Number.isFinite(fetchedAt) ? Math.floor(fetchedAt / 1000) : 0,
    unavailable: [],
  };
}

const LINE_ITEMS: Record<StatementKind, { key: string; label: string }[]> = {
  income: [
    { key: 'revenue', label: 'Revenue' },
    { key: 'costOfRevenue', label: 'Cost of revenue' },
    { key: 'grossProfit', label: 'Gross profit' },
    { key: 'researchAndDevelopmentExpenses', label: 'R&D expenses' },
    { key: 'operatingExpenses', label: 'Operating expenses' },
    { key: 'operatingIncome', label: 'Operating income' },
    { key: 'ebitda', label: 'EBITDA' },
    { key: 'incomeBeforeTax', label: 'Income before tax' },
    { key: 'incomeTaxExpense', label: 'Income tax' },
    { key: 'netIncome', label: 'Net income' },
    { key: 'epsDiluted', label: 'EPS (diluted)' },
    { key: 'weightedAverageShsOutDil', label: 'Diluted shares' },
  ],
  balance: [
    { key: 'cashAndShortTermInvestments', label: 'Cash and short-term investments' },
    { key: 'totalCurrentAssets', label: 'Total current assets' },
    { key: 'totalAssets', label: 'Total assets' },
    { key: 'totalCurrentLiabilities', label: 'Total current liabilities' },
    { key: 'totalDebt', label: 'Total debt' },
    { key: 'totalLiabilities', label: 'Total liabilities' },
    { key: 'totalStockholdersEquity', label: 'Stockholders equity' },
    { key: 'netDebt', label: 'Net debt' },
  ],
  cashflow: [
    { key: 'netIncome', label: 'Net income' },
    { key: 'depreciationAndAmortization', label: 'Depreciation and amortization' },
    { key: 'netCashProvidedByOperatingActivities', label: 'Operating cash flow' },
    { key: 'capitalExpenditure', label: 'Capital expenditure' },
    { key: 'freeCashFlow', label: 'Free cash flow' },
    { key: 'netCashProvidedByInvestingActivities', label: 'Investing cash flow' },
    { key: 'netCashProvidedByFinancingActivities', label: 'Financing cash flow' },
    { key: 'netChangeInCash', label: 'Net change in cash' },
  ],
};

const FILE: Record<StatementKind, string> = { income: 'income', balance: 'balance', cashflow: 'cashflow' };
const PERIODS = ['FY', 'Q1', 'Q2', 'Q3', 'Q4'] as const;

export function statementsFor(symbol: string, statement: StatementKind, period: StatementPeriod): StatementsResponse {
  const raw = recorded(symbol, `${FILE[statement]}-${period === 'annual' ? 'annual' : 'quarter'}`)?.body ?? [];
  const lineItems = LINE_ITEMS[statement];
  const rows: StatementRow[] = raw.flatMap((r) => {
    const fiscalPeriod = PERIODS.find((p) => p === r.period);
    const fiscalYear = Number(r.fiscalYear);
    if (!fiscalPeriod || !Number.isInteger(fiscalYear)) return [];
    const lines: Record<string, number | null> = {};
    for (const li of lineItems) lines[li.key] = num(r[li.key]);
    return [
      {
        fiscalYear,
        fiscalPeriod,
        periodEnd: String(r.date),
        filingDate: str(r.filingDate),
        reportedCurrency: str(r.reportedCurrency) ?? 'USD',
        lines,
      },
    ];
  });
  return { symbol, statement, period, lineItems, rows };
}

export function earningsFor(symbol: string): EarningsResponse {
  const raw = recorded(symbol, 'earnings')?.body ?? [];
  return {
    symbol,
    events: raw.map((e) => ({
      date: String(e.date),
      epsActual: num(e.epsActual),
      epsEstimate: num(e.epsEstimated),
      revenueActual: num(e.revenueActual),
      revenueEstimate: num(e.revenueEstimated),
    })),
  };
}
