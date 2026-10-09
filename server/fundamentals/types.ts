/**
 * FUNDAMENTALS SEAM — between the fundamentals provider and the HTTP layer.
 *
 * ORCHESTRATOR-OWNED. Frozen for Phase 5. Report problems; do not edit.
 *
 * This seam is separate from `MarketEngine` on purpose. Fundamentals change at most
 * once a quarter, cache for hours, have no live edge, and have no cross-timeframe
 * coherence rule. Market bars have all of those. Different access patterns get
 * different seams, so a provider can serve one and not the other.
 */
import type { EarningsResponse, FundamentalsOverview, StatementKind, StatementPeriod, StatementsResponse } from '@shared/types';

export interface FundamentalsProvider {
  /** False for a provider that serves no fundamentals. `/api/capabilities` reports it. */
  readonly available: boolean;

  /** @throws UnknownSymbolError (from server/market/types.ts) for an unknown symbol. */
  getOverview(symbol: string): Promise<FundamentalsOverview>;

  /** @throws UnknownSymbolError */
  getStatements(symbol: string, statement: StatementKind, period: StatementPeriod): Promise<StatementsResponse>;

  /** @throws UnknownSymbolError */
  getEarnings(symbol: string): Promise<EarningsResponse>;
}

// ───────────────────────────────────────────────────────────────────────────────
// INVARIANTS. Each one is an acceptance criterion and each one needs a test.
//
// 1. NULL, NEVER ZERO — AND PASS THROUGH WHAT THE PROVIDER SUPPLIES.
//    A value the provider does not supply is `null`, never 0 and never a guess.
//    A value the provider DOES supply is passed through unchanged, even when it is
//    not meaningful. Do not invent semantics in the provider. Two measured cases:
//      • JPM (a bank): FMP supplies grossProfitMarginTTM = 0.626, computed from a
//        "costOfRevenue" that for a bank is mostly interest expense. It is not a
//        meaningful gross margin, but FMP supplies it, so the provider passes it.
//      • RIVN (losses): FMP supplies priceToEarningsRatioTTM = -5.54. A negative P/E
//        is not meaningful and reads as "cheap", but the provider passes it.
//    The UI decides how to present these (see docs/PHASE5_PLAN.md, W6): non-positive
//    valuation multiples as "NM", and margins for financial-sector issuers as "NM".
//    Keeping the raw value lets the UI tell "not supplied" from "not meaningful".
//    The provider supplies the EVIDENCE for the gross-margin case as
//    `grossMarginNotMeaningful`: true when interest expense is at least 25% of the cost
//    of revenue in the newest annual income statement. Measured on FMP: banks 0.87-0.93,
//    broker-dealers 1.00, card lenders 0.43-0.61; card networks, payments, insurers and
//    asset managers 0.00-0.09. A sector or industry rule cannot separate these: FMP puts
//    Visa and Capital One in the same industry, and insurers have real gross margins.
//
// 2. RATIOS ARE FRACTIONS. 0.4512 means 45.12%. Measured on the recorded `ratios-ttm`
//    and `key-metrics-ttm` responses, the margin, yield, payout and return fields are
//    already fractions (AAPL grossProfitMarginTTM 0.4865, dividendYieldTTM 0.0032).
//    Other FMP endpoints use percentages (quote `changePercentage` is 1.02 for +1.02%).
//    Check the unit of EACH mapped field against a recorded response and test it.
//    FMP's field names are not the obvious ones: P/E is `priceToEarningsRatioTTM`.
//
// 3. FISCAL LABELS COME FROM THE PROVIDER. Use the provider's fiscal year and period
//    fields. Never derive them from a calendar date. MSFT's fiscal year 2026 ended in
//    June 2026. A derived label is wrong for every company whose year does not end in
//    December.
//
// 4. CURRENCY IS EXPLICIT. Statements are in `reportedCurrency`, which can differ from
//    the currency the listing trades in. Never assume USD. Measured: TSM REPORTS in
//    TWD and TRADES in USD. Never combine a USD price with a TWD per-share value — for
//    example never compute P/E as USD price / TWD EPS. Use the provider's own ratios.
//
// 5. FLOWS AND STOCKS ARE DIFFERENT.
//      • Income statement and cash-flow lines are FLOWS. Four quarters sum to the
//        fiscal year, for example revenue and net income.
//      • Balance-sheet lines are STOCKS. The fiscal-year value equals the Q4 value.
//        NEVER sum balance-sheet quarters.
//      • EPS does NOT sum exactly. Quarterly EPS uses each quarter's share count, and
//        buybacks change it. A test that asserts EPS sums exactly is WRONG.
//    Measured on FMP for AAPL and MSFT: revenue and net income sum exactly; EPS is
//    within about 0.1%. JPM revenue is within about 0.2% (bank revenue definitions).
//
// 6. NEWEST FIRST. Statement rows and earnings events are ordered newest first.
//
// 7. PARTIAL SUCCESS. If the metrics, scores or analyst section is not available
//    (for example HTTP 402 on the plan tier), set its fields to null and list it in
//    `unavailable`. Do not fail the whole overview. The overview fails only when the
//    profile is not available.
//
// 8. DO NOT DERIVE GATED DATA. On FMP Starter, quarterly `ratios` and `key-metrics`
//    return HTTP 402. Take TTM values from `ratios-ttm` and `key-metrics-ttm`. Do not
//    compute quarterly ratios from quarterly statements: the results would not agree
//    with the provider's own TTM values, and two different P/E numbers on one screen
//    are worse than one.
//
// 9. CACHE FOR HOURS. Overview and statements: 6 hours. Earnings: 1 hour, because
//    upcoming reports get their actual values. Cache successes only.
//
// 10. THE SYNTHETIC PROVIDER OBEYS 1–6 TOO. It is deterministic per symbol, and its
//     flows sum exactly to the fiscal year (revenue, net income, operating cash flow),
//     and its balance-sheet fiscal-year values equal Q4. It is what the tests and
//     offline development use, so it must model reality, not only fill the screen.
// ───────────────────────────────────────────────────────────────────────────────
