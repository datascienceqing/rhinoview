/**
 * The curated, ordered line items of each statement, shared by both providers.
 *
 * `key` is the FMP field name on purpose: the FMP mapper copies the value under the same
 * key, and the synthetic provider emits the same keys, so the client sees one shape
 * whichever provider is active. A line the issuer does not report is `null`, never 0.
 *
 * Flows (income, cash flow) sum across quarters; stocks (balance) do not. The lists
 * avoid stock lines inside the cash-flow statement (for example `cashAtEndOfPeriod`)
 * so "four quarters sum to the year" holds for every line of those two statements.
 */
import type { StatementKind } from '@shared/types';

export interface LineItemSpec {
  key: string;
  label: string;
}

export const LINE_ITEMS: Record<StatementKind, readonly LineItemSpec[]> = {
  income: [
    { key: 'revenue', label: 'Revenue' },
    { key: 'costOfRevenue', label: 'Cost of revenue' },
    { key: 'grossProfit', label: 'Gross profit' },
    { key: 'researchAndDevelopmentExpenses', label: 'Research & development' },
    { key: 'sellingGeneralAndAdministrativeExpenses', label: 'Selling, general & administrative' },
    { key: 'operatingExpenses', label: 'Operating expenses' },
    { key: 'operatingIncome', label: 'Operating income' },
    { key: 'ebitda', label: 'EBITDA' },
    { key: 'interestExpense', label: 'Interest expense' },
    { key: 'incomeBeforeTax', label: 'Income before tax' },
    { key: 'incomeTaxExpense', label: 'Income tax expense' },
    { key: 'netIncome', label: 'Net income' },
    { key: 'epsDiluted', label: 'Diluted EPS' },
    { key: 'weightedAverageShsOutDil', label: 'Diluted shares outstanding' },
  ],
  balance: [
    { key: 'cashAndCashEquivalents', label: 'Cash & equivalents' },
    { key: 'cashAndShortTermInvestments', label: 'Cash & short-term investments' },
    { key: 'netReceivables', label: 'Receivables' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'totalCurrentAssets', label: 'Total current assets' },
    { key: 'propertyPlantEquipmentNet', label: 'Property, plant & equipment' },
    { key: 'goodwillAndIntangibleAssets', label: 'Goodwill & intangibles' },
    { key: 'totalAssets', label: 'Total assets' },
    { key: 'totalCurrentLiabilities', label: 'Total current liabilities' },
    { key: 'shortTermDebt', label: 'Short-term debt' },
    { key: 'longTermDebt', label: 'Long-term debt' },
    { key: 'totalDebt', label: 'Total debt' },
    { key: 'netDebt', label: 'Net debt' },
    { key: 'totalLiabilities', label: 'Total liabilities' },
    { key: 'totalEquity', label: 'Total equity' },
  ],
  cashflow: [
    { key: 'netIncome', label: 'Net income' },
    { key: 'depreciationAndAmortization', label: 'Depreciation & amortization' },
    { key: 'stockBasedCompensation', label: 'Stock-based compensation' },
    { key: 'changeInWorkingCapital', label: 'Change in working capital' },
    { key: 'operatingCashFlow', label: 'Operating cash flow' },
    { key: 'capitalExpenditure', label: 'Capital expenditure' },
    { key: 'freeCashFlow', label: 'Free cash flow' },
    { key: 'netCashProvidedByInvestingActivities', label: 'Investing cash flow' },
    { key: 'commonStockRepurchased', label: 'Share buybacks' },
    { key: 'netDividendsPaid', label: 'Dividends paid' },
    { key: 'netCashProvidedByFinancingActivities', label: 'Financing cash flow' },
    { key: 'netChangeInCash', label: 'Net change in cash' },
  ],
};

/** Most rows a statements response carries, by period (CONTRACT: 10 fiscal years, 8 quarters). */
export const MAX_STATEMENT_ROWS = { annual: 10, quarter: 8 } as const;

export function lineItemsFor(statement: StatementKind): { key: string; label: string }[] {
  return LINE_ITEMS[statement].map(({ key, label }) => ({ key, label }));
}
