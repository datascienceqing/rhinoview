# FMP fundamentals fixtures

Real FMP `/stable` responses, recorded on 2026-10-04 with an FMP Starter key. The key is
not in any file: each file stores the request `path` without it, the HTTP `status`, and
the raw `body`. A test asserts that no fixture contains `apikey`.

Each symbol tests one difficult case:

| Symbol | Case |
|---|---|
| AAPL | Baseline. Fiscal year ends in September. |
| MSFT | Fiscal year ends in June: FY2026 Q1 ended 2025-09-30. |
| JPM  | A bank. FMP still supplies a gross margin (0.626); it is not meaningful. |
| TSM  | Reports in TWD, trades in USD. |
| RIVN | Losses. FMP supplies a negative P/E (-5.54). |

`_gated/` holds the real HTTP 402 bodies for quarterly `ratios` and `key-metrics`,
which the Starter plan does not include.

These fixtures make the build hermetic: no worker needs an API key to develop or test.
Live verification against the API is separate, and needs `FMP_API_KEY`.
