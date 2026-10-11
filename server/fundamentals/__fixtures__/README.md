# FMP fundamentals fixtures

These files have the shape of real FMP `/stable` responses, but their values are
**synthetic**. Real market data may not be redistributed, so the recorded responses
(2026-10-04, FMP Starter) went through `scripts/gen-synthetic-fmp-fixtures.ts`. Each file
keeps the request `path`, the HTTP `status`, the keys, the row counts, the dates, the
fiscal labels and the currencies. Every price, amount, ratio and text is new. A test
asserts that every data fixture has `"synthetic": true`, and that no fixture contains
`apikey`.

The values come from a small invented model per company. These relations hold exactly:

- Four quarterly revenue, net income and operating cash flow values add up to their
  fiscal year.
- The fiscal-year balance sheet is the Q4 balance sheet.
- The margins, EPS and P/E in `ratios-ttm` come from the last four synthetic quarters.

Each symbol tests one difficult case:

| Symbol | Case |
|---|---|
| AAPL | Baseline. Fiscal year ends in September. |
| MSFT | Fiscal year ends in June: FY2026 Q1 ended 2025-09-30. |
| JPM  | A bank. FMP still supplies a gross margin (0.6 here); it is not meaningful, because most of the cost of revenue is interest expense. |
| TSM  | Reports in TWD, trades in USD. Its EPS in TWD is larger than its USD price. |
| RIVN | Losses. The P/E is negative (-4.02 here). |

`_gated/` holds FMP's own HTTP 402 bodies for quarterly `ratios` and `key-metrics`,
which the Starter plan does not include. They are error text, not data.

To add a fixture: record the response, then run the generator and
`scripts/gen-fundamentals-mock.ts`. Never commit a recorded data response.

These fixtures make the build hermetic: no worker needs an API key to develop or test.
Live verification against the API is separate, and needs `FMP_API_KEY`.
