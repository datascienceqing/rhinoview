# Phase 5 Report — Watchlists, Named Layouts, Fundamentals

Branch: `claude/nice-cannon-ew871u`. The plan named the branch `phase-5`. The user approved
the `claude/` branch for this session. The deliverable is one pull request to `main`.

## 1. Summary

Six workers built Phase 5 in parallel, in separate paths. The orchestrator verified each
worker, did two review gates, and did the integration. All checks pass. The live FMP checks
were not done, because `FMP_API_KEY` was not set.

## 2. Environment and test counts

| Item | Before (main, `a17af91`) | After (this branch) |
|---|---|---|
| Node | 22.22.0 | 22.22.0 |
| `npm run typecheck` | clean | clean |
| `npm run lint` | clean | clean |
| Test files | 40 passed, 1 skipped | 67 passed, 1 skipped |
| Tests | 1467 passed, 5 skipped | 2084 passed, 5 skipped |

The orchestrator ran the full suite on an idle machine two times in a row. Both runs passed.

## 3. What each worker built

- **W1 — FMP intraday and batch quotes.** The FMP engine serves 5m, 15m and 1h bars. It parses
  the FMP time as New York wall-clock time. `GET /api/quotes` fans out with a limit of 5. It uses
  a shared 15-second cache and returns partial success with `missing` and `failed`.
- **W2 — fundamentals.** A synthetic provider and an FMP provider. `DATA_PROVIDER` selects the
  provider. The three routes validate the query with zod. A cache keeps successes for 6 h
  (overview, statements) and 1 h (earnings).
- **W3 — workspace store.** A JSON file store with atomic writes and serialized updates. A stale
  revision gives `CONFLICT`. A corrupt file is renamed to `.corrupt-<ts>`. All ten routes are done.
- **W4 — named layouts.** `WorkspaceProvider` loads and saves layouts with a debounce and the
  revision. A layout switcher is in the toolbar. Indicators belong to the layout. A one-time
  migration moves the old localStorage indicators into the layout.
- **W5 — watchlist.** Multiple named lists in the right sidebar, with sort and reorder (drag and
  Alt+Up/Down). It polls `/api/quotes` every 30 s while the page is visible.
- **W6 — financials drawer.** Four tabs: Overview, Statements, Trends and Earnings. The chart shows
  an "E" marker for each past earnings report.

## 4. Orchestrator verification

1. **Mutation checks.** For one core rule of each worker, the orchestrator broke the rule, saw the
   tests fail, and restored the file. All sixteen mutations failed tests.

   | Rule | Tests that failed |
   |---|---|
   | W1 quotes concurrency limit 5 | 1 |
   | W1 symbol rule (F1) | 3 |
   | W1 one lost session sets `truncated` (F12) | 4 |
   | W2 empty profile gives `UNKNOWN_SYMBOL` | 5 |
   | W2 fundamentals symbol rule (F2) | 1 |
   | W3 stale revision gives `CONFLICT` | 6 |
   | W4 no blind retry after `CONFLICT` | 3 |
   | W5 poll only while the page is visible | 2 |
   | W6 New York midnight across DST | 4 |
   | W1 session close after `from` (F12) | 3 |
   | W1 clip inside the oldest day (G6-5) | 5 |
   | W4 refresh keeps pending edits (G6-1) | 1 |
   | W5 `BRK.B` matches `BRK-B` (G6-3) | 1 |
   | W5 "unavailable" after the first response (G6-3) | 1 |
   | W2 route cuts earnings to `limit` (section 10) | 4 |
   | W6 "Show more" hides when the list is complete (section 10) | 2 |

2. **End-to-end against the real server (plan 5.2).** `node scripts/e2e-phase5.mjs` starts a
   server with synthetic data and a temporary workspace file. Result: 41 passed, 0 failed.
   The base script came from the `phase-5` branch of another session. This branch added checks
   for the Gate 5 repairs.
3. **Client against the real server (plan 5.3).** `scripts/browser-phase5.mjs` uses headless
   Chromium at 1440 × 900. Result: 10 passed, 0 failed. The orchestrator also looked at the
   screenshots. The daily chart showed a red "E" marker. The marker agreed with the "Miss" row of
   the Earnings tab.
4. **Live FMP checks (plan 5.4).** Not done. `FMP_API_KEY` was not set. Not verified live.

## 5. Gate 5 findings and what happened

The reviewer found one blocking finding and ten non-blocking findings. The orchestrator found
three more (F12–F14). All are repaired.

| ID | Severity | Owner | Finding | Result |
|---|---|---|---|---|
| F1 | blocking | W1 | One `^GSPC` symbol made the full `/api/quotes` request fail. | Repaired. The route uses the store symbol rule. |
| F2 | non-blocking | W2 | Fundamentals refused `^` and `=` with `BAD_REQUEST`. | Repaired. Such a symbol gives `UNKNOWN_SYMBOL`. |
| F3 | non-blocking | W6 | The fundamentals mock had other line items and labels than the server. | Repaired by the orchestrator (plan 5.1). |
| F4 | non-blocking | W2/W6 | The overview "EPS (diluted)" is net income per share (TTM). | Repaired. The label is "EPS (TTM)". |
| F5 | non-blocking | W2 | A 402 with symbol scope on `/profile` gave HTTP 500. | Repaired. It now means unknown symbol. |
| F6 | non-blocking | CONTRACT | The workspace mock accepted more than the server. | Repaired by the orchestrator. |
| F7 | non-blocking | W5 | The quotes mock did not trim or check characters. | Repaired. |
| F8 | non-blocking | W4 | An edit just before the tab closes was lost. | Repaired. `pagehide` sends a `keepalive` save. |
| F9 | non-blocking | W5 | The watchlist table was 440 px wide in a 300 px sidebar. | Repaired. Verified in the browser. |
| F10 | non-blocking | W4 | A layout deleted in another tab stayed in the list. | Repaired. |
| F11 | non-blocking | W4 | Edits made while the layouts load were lost. | Repaired. |
| F12 | blocking | W1 | Intraday `truncated` stayed false when exactly one session was lost. | Repaired. |
| F13 | non-blocking | W6 | Share counts looked like money. | Repaired. |
| F14 | non-blocking | W5 | Only the symbol button selected a row. The plan says "click a row". | Repaired. Verified in the browser. |

The orchestrator found F12 and F13 in the `phase-5` branch of another session, and found F14 in
the browser check.

## 6. Gate 6 findings

The final reviewer found no blocking finding. Its own full test run passed. The orchestrator
sent the clear defects to their owners in one round.

| ID | Severity | Owner | Finding | Result |
|---|---|---|---|---|
| G6-1 | non-blocking | W4 | A refresh after `NOT_FOUND` removed pending edits from the screen and remounted the chart. | Repaired. |
| G6-2 | non-blocking | W4 | After a failed refetch, Retry showed "Saved" for an edit that the server refused. | Repaired. |
| G6-3 | non-blocking | W5 | A row for `BRK.B` showed "loading…" forever when the server returned `BRK-B`. | Repaired. |
| G6-4 | non-blocking | W1/CONTRACT | The FMP engine refuses `^` and `=` symbols, so they are always `missing` under FMP. | User decision: show "not found" for now. No code change. |
| G6-5 | non-blocking | W1 | FMP can clip the morning of the oldest day without a signal. | Repaired. |
| G6-6 | non-blocking | W5 | One failed watchlist write dropped all queued writes. | Repaired. |
| G6-7 | non-blocking | W4 | One keepalive test passed with no request. | Repaired. |
| G6-8 | non-blocking | W1 | The limit of 5 is for each request, not for the server. | Open. The rate budget still holds. |

The W4 repair for G6-2 also repaired a related defect: the save state stayed "error" after a
successful adopt.

## 7. CONTRACT findings (changes to frozen files)

1. **`src/data/request.ts`** — `apiRequest` takes `keepalive`. F8 needs it.
2. **`mocks/workspace.ts` and `mocks/envelope.ts`** — the mock parses bodies with the server zod
   schemas. It answers 201 on POST, and it changes the active ids all or nothing. F6 needs it.
3. **`src/ui/SymbolSearch.tsx`** — `SymbolSearch` takes a `label`. The watchlist search is "Add
   symbol to watchlist". Two inputs with one name broke two App tests and confuse screen readers.
4. **`src/App.test.tsx`** — the test helper waits for the toolbar search results only, because the
   watchlist adds `<option>` elements. Each test resets the workspace mock.
5. **The symbol rule is not in `shared/`.** The rule `/^[A-Za-z0-9.^=-]{1,16}$/` is now in four
   files: the store, the quotes route, the fundamentals route and the quotes mock. Each copy has a
   comment. A later phase can move it to `shared/types.ts`.

## 8. Decisions

The user decided these items after Gate 6:

1. **Branch for the merge.** The `phase-5` branch is not complete. Do not merge it. Merge only
   the pull request from `claude/nice-cannon-ew871u`.
2. **Earnings history length.** The earnings response holds 40 events by default. An optional
   `limit` (up to 400) gets more. The Earnings tab has a "Show more" button that gets 40 more.
   See section 10.
3. **Index symbols under FMP (G6-4).** Show "not found" for now. A live check of the FMP
   spelling can change this later.

These items stay open for the user at review:

1. **Overview EPS.** It is FMP `netIncomePerShareTTM`, labelled "EPS (TTM)". It differs a little
   from the sum of four quarters of diluted EPS (AAPL 8.775 against 8.73).
2. **All-unknown quotes request.** A request with only unknown symbols succeeds, with all symbols
   in `missing`. Only a request where every symbol failed is an error.
3. **Several open tabs.** Each tab polls quotes. The rate budget assumes one tab. The limit of 5
   is for each request (G6-8).
4. **Layout details.** The watchlist is 300 px. The Financials drawer is below the chart. The
   layout switcher is at the left of the toolbar.

## 9. Not verified

- The live FMP checks (plan 5.4). There was no key.
- A real browser other than headless Chromium. The checks used one window size, 1440 × 900.
- A drag of a watchlist row in a real browser. Only jsdom drag events were tested.
- The `keepalive` save when a real tab closes. A test checks only the flag on the request.
- The headless browser in this container reports the locale `en-US@posix`. The chart library
  then logs `RangeError`. The browser check sets the locale to `en-US`. A real browser does not
  report `@posix`.

## 10. Earnings limit (user decision after Gate 6)

The user asked for 40 earnings events by default, with an option to get more.

- **Contract.** `GET /api/fundamentals/earnings` takes an optional `limit`, an integer from 1 to
  400. The default is 40. Any other value gives `BAD_REQUEST`. `DEFAULT_EARNINGS_LIMIT` and
  `MAX_EARNINGS_LIMIT` are in `shared/types.ts`. This is a change to a frozen file.
- **W2 — server.** The route cuts the newest `limit` events from the cached full list, so a
  larger `limit` costs no upstream call. The synthetic provider now gives 48 events for an
  established symbol, so "Show more" can be tested offline.
- **W6 — client and mock.** The Earnings tab and the chart markers share one request for 40
  events. "Show more" asks for 40 more in a separate request. The markers stay at 40. The
  button hides when the list is complete or when the limit reaches 400. The mock applies the
  same `limit` rule.
- **Verification.**
  - The full suite passes: 2084 passed, 5 skipped.
  - Two mutation checks made tests fail.
  - The end-to-end script checks the default, `limit=10` and four bad values.
  - The browser check showed 40 rows, then more rows after "Show more", and then no button.

