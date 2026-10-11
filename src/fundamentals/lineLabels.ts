/**
 * Chinese names of the statement line items. The server sends English labels with each
 * line (server/fundamentals/lineItems.ts); in Chinese the client shows these by key, and
 * falls back to the server's label for a key it does not know.
 */
import { getLocale } from '../i18n/locale';

const ZH: Record<string, string> = {
  revenue: '营业收入',
  costOfRevenue: '营业成本',
  grossProfit: '毛利润',
  researchAndDevelopmentExpenses: '研发费用',
  sellingGeneralAndAdministrativeExpenses: '销售、一般及管理费用',
  operatingExpenses: '营业费用',
  operatingIncome: '营业利润',
  ebitda: 'EBITDA',
  interestExpense: '利息费用',
  incomeBeforeTax: '税前利润',
  incomeTaxExpense: '所得税费用',
  netIncome: '净利润',
  epsDiluted: '稀释每股收益',
  weightedAverageShsOutDil: '稀释后流通股数',
  cashAndCashEquivalents: '现金及现金等价物',
  cashAndShortTermInvestments: '现金及短期投资',
  netReceivables: '应收账款',
  inventory: '存货',
  totalCurrentAssets: '流动资产合计',
  propertyPlantEquipmentNet: '固定资产净值',
  goodwillAndIntangibleAssets: '商誉及无形资产',
  totalAssets: '资产总计',
  totalCurrentLiabilities: '流动负债合计',
  shortTermDebt: '短期借款',
  longTermDebt: '长期借款',
  totalDebt: '总债务',
  netDebt: '净债务',
  totalLiabilities: '负债合计',
  totalEquity: '股东权益合计',
  depreciationAndAmortization: '折旧与摊销',
  stockBasedCompensation: '股权激励费用',
  changeInWorkingCapital: '营运资本变动',
  operatingCashFlow: '经营活动现金流',
  capitalExpenditure: '资本支出',
  freeCashFlow: '自由现金流',
  netCashProvidedByInvestingActivities: '投资活动现金流',
  commonStockRepurchased: '股票回购',
  netDividendsPaid: '支付股息',
  netCashProvidedByFinancingActivities: '筹资活动现金流',
  netChangeInCash: '现金净变动',
};

/** The label of a statement line in the current language. */
export function lineLabel(key: string, serverLabel: string): string {
  return getLocale() === 'zh' ? (ZH[key] ?? serverLabel) : serverLabel;
}

/** For tests: every key that has a Chinese label. */
export const ZH_LINE_KEYS: readonly string[] = Object.keys(ZH);
