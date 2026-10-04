# Phase 5 Plan — Watchlists, Named Layouts, Fundamentals

This plan is for an **unattended cloud orchestrator**. It starts with no context. Read
all of it before you start. Then read `AGENTS.md`, `docs/AGENT_BRIEF.md`,
`docs/CONTRACT.md` (especially the Phase 5 section), and `shared/types.ts`.

---

## 0. Rules for the orchestrator

1. **You orchestrate.** Workers write the code. You verify, integrate, and report.
   Use the Agent tool: workers use `model: "sonnet"`, reviewers use `model: "opus"`.
   If the Agent tool is not available, do the worker tasks yourself, one at a time,
   in the order of section 3.
2. **Work on the branch `phase-5`.** Create it from `main`. Never push to `main`.
   Never merge. The deliverable is a pull request.
3. **Write all output for the user in ASD-STE100 style.** See `AGENTS.md`. This
   includes the PR description, commit messages, and `docs/PHASE5_REPORT.md`.
4. **Prepare the environment first.**
   - Run `node -v`. The project needs Node 22 or later. Node 20 makes the engine about
     5× slower. If the version is older than 22, install Node 22 (for example with
     nvm). If you cannot, continue, and record it in the report.
   - Run `npm ci`. Then run `npm run typecheck`, `npm run lint`, and `npm test`.
     All must pass before you start a worker. Record the baseline counts.
5. **The FMP key can be absent.** The cloud does not have the local `.env`. The build
   does not need the key: real FMP responses are recorded in
   `server/fundamentals/__fixtures__/fmp/` and `server/market/fmp/__fixtures__/phase5/`.
   If `FMP_API_KEY` is set, do the live checks in section 5.4. If it is not set, do not
   do them, and write "not verified live" in the report. Never write a key to a file,
   a log, a commit, or the PR.
6. **Verify every worker claim yourself.** Run the commands again. Read the diff.
   For each important fix, do a mutation check: break the fix, see the test fail,
   restore it. A worker report is evidence, not proof.
7. **Do not commit while a worker runs.** In an earlier phase, `git add -A` during a
   worker run put that worker's unfinished files into an unrelated commit. Commit
   only when all workers are idle. Use one commit for each worker's work.
8. **Push after each wave.** A long run can stop. Pushed work survives.
9. **Frozen files.** Do not edit the files in section 2 unless a gate finds a defect in
   them. If you must edit one, record it in the report as a CONTRACT finding.
10. **Review rounds.** Send findings to the worker that wrote the code (SendMessage keeps
    its context). Use at most two rounds for each gate. After that, record the open
    item in the report and continue.

---

## 1. Scope — decisions the user made

Do not change these.

| Topic | Decision |
|---|---|
| Named charts | **Named layouts, one chart each.** Not multi-chart grids. |
| Persistence | **Server-side JSON file.** Layouts and watchlists follow the user to any browser. |
| Watchlist | **Multiple named lists**, **sort and reorder**, **right-side panel**, columns **last, change, change %, volume, day range**. |
| Fundamentals | **Key metrics snapshot**, **financial statements**, **trend charts**, **earnings and analysts** (including "E" markers on the price chart). |
| Finish | **Open a PR only.** The user reviews and merges. |

Layout details that the orchestrator decided (the user can change them at review):

- The watchlist is a fixed right sidebar, 300 px wide.
- Financials is a full-width drawer below the chart. A "Financials" button in the
  toolbar opens and closes it. It has four tabs: Overview, Statements, Trends, Earnings.
- The layout switcher is a dropdown at the left end of the toolbar.

---

## 2. Wave 0 — already done, frozen

The orchestrator of the local session wrote and tested these files. They are the
seams that let six workers run in parallel without editing each other's files.

| File | What it defines |
|---|---|
| `shared/types.ts` (PHASE 5 section) | `Capabilities`, `QuotesResponse`, `ChartLayout`, `Watchlist`, `Workspace`, request bodies, all fundamentals types, limits. New error codes `NOT_FOUND`, `CONFLICT`. |
| `docs/CONTRACT.md` (Phase 5 section) | Every new endpoint, the quote fan-out rule, the rate budget, the FMP traps. |
| `server/market/types.ts` | Invariant 2 rescoped: coherence within timeframe families only. |
| `server/fundamentals/types.ts` | `FundamentalsProvider` and ten invariants, several from measured FMP data. |
| `server/workspace/types.ts` | `WorkspaceStore`, its errors, and thirteen invariants. |
| `server/routes/{quotes,fundamentals,workspace}.ts` | Route stubs, already registered in `server/index.ts`. |
| `server/index.ts` | Builds and registers all Phase 5 modules. `buildServer` takes `fundamentals` and `workspace`. |
| `src/workspace/types.ts` | The client seam: `ActiveChart`, `ActiveChartApi`. |
| `src/workspace/ActiveChartContext.tsx` | `useActiveChart()` and the in-memory provider. |
| `src/data/request.ts` | `apiRequest` — the ONE place the client calls HTTP. |
| `src/data/capabilities.ts` | `useCapabilities()`, fetched once and shared. |
| `src/chart/markers.ts` | `ChartMarker` and `snapMarkers` (a date goes to the bar that contains it). |
| `src/App.tsx` | The frame with three slots. Workers fill slots; they do not edit this file. |
| `mocks/workspace.ts` | A strict MSW mock of every workspace endpoint, guarded by tests. |
| `mocks/envelope.ts` | Shared `ok` / `fail` helpers for MSW. |
| Fixtures | Real FMP responses for AAPL, MSFT, JPM, TSM, RIVN, plus 402 bodies. |

Baseline at the end of wave 0: typecheck clean, lint clean, all tests pass.

---

## 3. Wave 1 — six workers, in parallel

Start all six at the same time. Each one owns a set of paths and writes **only** there.
Client workers build against MSW mocks, so they do not wait for server workers.

**Give each worker this in its prompt:** read `AGENTS.md`, `docs/AGENT_BRIEF.md`, the
Phase 5 section of `docs/CONTRACT.md`, the seam files named below, and this section.
Do not run `npm install`. While you develop, run only your own tests
(`npx vitest run <your paths>`): six workers share one machine, and full-suite runs
in parallel are slow. Run the full suite once at the end. Report with pasted command
output, contract deviations, and known gaps.

### W1 — FMP intraday and batch quotes (server)

**Owns:** `server/market/fmp/**`, `server/routes/quotes.ts`, new files `server/provider/quotes.ts`
and `server/cache/quotesCache.ts`, and their tests.

**Task A — intraday on the FMP engine.** The FMP Starter plan serves 5min, 15min and
1hour. Set `supportedTimeframes` to `['5m','15m','1h','1D','1W']`. 1min is HTTP 402.

Measured facts. Do not discover these again:
- Intraday `date` is a New York wall-clock string, `"2026-10-02 09:30:00"`, with no zone.
  Parse it as America/New_York with `server/market/calendar.ts`. As UTC, every bar is
  four or five hours wrong.
- Rows come back newest first. Sort them ascending.
- 5min returns at most 624 rows for one request, anchored to `to` (the newest rows are
  kept). Moving `to` back pages into older data (verified back to June 2025). Caps for
  15min and 1hour are not measured. Use one rule for all: if the oldest returned bar is
  more than one session after `from`, set `truncated: true`. The client then continues
  from the oldest bar, as guarantee 4 already says.
- Hourly bars are session-aligned: 09:30, 10:30, … 15:30. This matches the synthetic engine.
- 5min bars aggregate exactly into 1hour bars (7/7 checked). Intraday 5min volume is
  66–75% of the daily volume. That is correct data (see invariant 2). Do not "fix" it.
- **Do not change `closeLiveEdge`** to rebuild bars from 5min. Because the engine does
  not serve `1m`, it passes the provider's own forming bar through. That is correct.

Fixtures: `server/market/fmp/__fixtures__/phase5/` (5min/15min/1hour for two days,
an older 5min page, the 1min 402 body, the same days at 1D, and quotes).

**Task B — `GET /api/quotes`.** Follow the contract exactly: fan-out to
`getSnapshot`, concurrency 5, a 15-second quote cache shared by all callers, partial
success with `missing` and `failed`. Never use the comma-list quote: it answers 200
with an empty array (`quote-comma-list-TRAP.json`). Test partial success, the cache,
the concurrency limit, and that one slow symbol does not block the others.

### W2 — fundamentals providers and routes (server)

**Owns:** `server/fundamentals/**` except `types.ts`, `server/routes/fundamentals.ts`, tests.

**Task.** Implement `createFundamentalsProvider()` with two providers, selected by
`DATA_PROVIDER`: a **synthetic** provider and an **FMP** provider. Implement the three
routes with zod validation and the contract's error mapping. Obey all ten invariants
in `server/fundamentals/types.ts`; each needs a test.

- **FMP mapping.** Build it from the recorded fixtures. Choose a curated, ordered list of
  line items for each statement, with display labels: about 12–15 lines each, for example
  revenue, gross profit, operating income, net income, diluted EPS (income); cash, total
  assets, total debt, total equity (balance); operating cash flow, capital expenditure,
  free cash flow, dividends paid, buybacks (cash flow). Take exact FMP keys from the fixtures.
- **Unknown symbol.** Decide it from the `profile` response (an empty array). FMP
  overloads HTTP 402 for some unknown symbols, so never treat a 402 alone as "unknown".
- **Pass values through** (invariant 1). JPM's gross margin (0.626) and RIVN's negative
  P/E (−5.54) go to the client unchanged. The UI decides how to show them.
- **Synthetic provider.** Deterministic per symbol. Flows sum exactly to the fiscal year;
  balance-sheet fiscal-year values equal Q4. Make its numbers plausible for the symbol's
  price in the synthetic market engine. Tests and offline development depend on it.
- **Do not assert that EPS sums exactly** across quarters. It does not, and it should not.

### W3 — workspace store and routes (server)

**Owns:** `server/workspace/**` except `types.ts`, `server/routes/workspace.ts`, tests.

**Task.** Implement `createWorkspaceStore(filePath)` and every route in the contract's
workspace table. Obey all thirteen invariants in `server/workspace/types.ts`.

- POST answers 201. Map the three error classes to `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST`.
- **Indicator validation must match the client editor exactly.** Import
  `checkIndicatorParams` from `src/indicators/params.ts`. It is pure. This is the one
  sanctioned production import from `src/` into `server/`: if the two sides validate
  differently, the server rejects layouts that the editor accepted.
- Tests that matter most: a crash between the temporary write and the rename leaves the
  old file intact; a corrupt file is renamed to `.corrupt-<ts>` and the store starts
  fresh; 20 parallel updates lose nothing (serialized); a stale revision gives 409;
  limits; the last layout cannot be deleted; active ids move correctly on delete.
- Use a temporary directory for every test. Never touch the real `data/` directory.

### W4 — named layouts (client)

**Owns:** `src/layouts/**`, `src/workspace/**` except `types.ts`, `src/ui/ChartPanel.tsx`,
`src/ui/TimeframeSelector.tsx`, `src/panes/storage.ts` and the panes code that reads it, tests.

**Task.**
- **Persistent provider.** Add a provider that loads `GET /api/layouts`, exposes the
  active layout through the frozen `ActiveChartApi`, and saves changes with
  `PUT /api/layouts/:id` (debounce about 500 ms, carry `revision`). Export it as
  `WorkspaceProvider` from `src/workspace/index.ts`. `App.tsx` must not change.
- **Conflicts.** On `CONFLICT`, refetch, adopt the server's version, and show a short
  notice. Never retry the same write blindly.
- **Layout switcher.** A dropdown in the toolbar slot: list and switch layouts
  (`PUT /api/workspace/active`), New, Rename, Duplicate, and Delete with a confirmation.
  Show the save state (saved / saving / error).
- **Indicators belong to the layout.** Change `ChartPanel` to read and write indicators
  through `useActiveChart()`, not through the per-symbol localStorage of Phase 3.
- **One-time migration.** On first load, if the active layout has no indicators and
  localStorage has `charting-app:indicators:<symbol>` for its symbol, import that entry
  into the layout. Then remove all `charting-app:indicators:*` keys and set
  `rhinoview:indicators-migrated=1`. Wrap every storage access in try/catch.
- **Keep the markers prop.** `ChartPanel` receives `markers` from the shell (wave 0).
  Keep passing it to `ChartView`.
- **Capabilities.** `TimeframeSelector` disables timeframes that `useCapabilities()` does
  not list (all enabled while it is null). If the active layout's timeframe is not
  supported, show the nearest supported timeframe (prefer the next coarser one), show a
  notice, and do not change the saved layout until the user picks a timeframe.

### W5 — watchlist (client)

**Owns:** `src/watchlist/**`, `mocks/quotes.ts`, tests.

**Task.** Fill the `WatchlistPanel` slot in the right sidebar.
- **Named lists.** Select, create, rename, and delete lists through `/api/watchlists`.
  Store the active list with `PUT /api/workspace/active` (`activeWatchlistId` only).
- **Rows.** Symbol, last, change, change %, volume, day range (low–high). Colour change by
  sign with `--up` / `--down`. Show `missing` symbols as "not found" and `failed` symbols
  as "unavailable" — never as a blank or a zero.
- **Add and remove symbols.** Reuse the `SymbolSearch` component from `src/ui` (import it,
  do not edit it). Save with `PUT /api/watchlists/:id` and `revision`; handle `CONFLICT`.
- **Sort.** Click a column header to sort ascending, then descending, then off. Sorting is
  a view state; it does not change the saved order.
- **Reorder.** Drag to reorder, and also a keyboard method (for example Alt+↑/↓). Save the
  order. Disable reordering while a sort is active, and say why.
- **Click a row** to call `useActiveChart().setSymbol`. Highlight the active symbol.
- **Polling.** `GET /api/quotes` every 30 s, only while the page is visible. Show a
  "Delayed" badge when the data is delayed.
- **Mock.** Write `mocks/quotes.ts` to the exact contract. Give each symbol different
  values, or a sort test cannot tell a sorted list from an unsorted one.

### W6 — financials drawer and earnings markers (client)

**Owns:** `src/fundamentals/**`, `mocks/fundamentals.ts`, tests.

**Task.** Fill the `FundamentalsDrawer` slot and implement `useEarningsMarkers`.
- **Overview tab.** Company profile summary; the key metrics, grouped (valuation,
  profitability, health, per share, dividend); Piotroski and Altman scores; analyst
  consensus with the price target range against the current price.
- **Statements tab.** Income, balance sheet, cash flow; annual or quarterly. Label periods
  with the provider's fiscal labels ("FY2026", "Q1 FY2026"), never calendar years. Show the
  reporting currency. Format large numbers (B, M).
- **Trends tab.** Small charts of revenue, net income and EPS, gross/operating/net margin
  for each period (computed from that period's statement lines), and free cash flow.
  Annual or quarterly. Use `lightweight-charts` or inline SVG. Add no dependency.
- **Earnings tab.** Actual against estimate for EPS and revenue, beat or miss, surprise %.
  Upcoming reports have no actuals; show them as upcoming.
- **Earnings markers.** `useEarningsMarkers(symbol)` returns one `ChartMarker` for each
  past report, dated 00:00 America/New_York of the report date, text "E", coloured
  `--up` for a beat and `--down` for a miss. Share the fetch with the Earnings tab.
- **Presentation rules, from measured data:**
  - `null` shows as "—".
  - A valuation multiple (P/E, PEG, EV/EBITDA, P/S, P/B) that is zero or negative shows as
    "NM" with a tooltip "not meaningful: negative earnings". RIVN's P/E is −5.54.
  - Margins for an issuer whose `profile.sector` is "Financial Services" show as "NM".
    JPM's gross margin from FMP is 0.626 and is not a real gross margin.
  - Fractions show as percentages (0.4865 → 48.65%).
  - Statements are in `reportedCurrency`; TSM reports in TWD. Label it.
- **Mock.** Write `mocks/fundamentals.ts` from the recorded fixtures with a simple mapping.
  At integration, the orchestrator replaces its data with output from W2's real mapper.

---

## 4. Gate 5 — review all six diffs together

Use one reviewer (`model: "opus"`, read-only tools). Give it the paths of all six workers,
this plan, and the frozen files. Cross-worker drift is its main target. Ask it to check:

- **W6 mock mapping against W2 real mapping.** Field names, units, nulls, fiscal labels,
  ordering. Any difference is a finding.
- **W5 against W1.** Partial success, `missing` and `failed`, the 50-symbol limit,
  polling rate against the rate budget.
- **W4 against W3.** Indicator validation agrees on both sides; revision handling; what
  each side does on `CONFLICT` and `NOT_FOUND`; the last-layout rule.
- **Mocks against the server.** Each mock must refuse what the server refuses. A mock that
  accepted more than the server hid a blocking defect in Phase 1.
- **Time.** Earnings dates become NY-midnight seconds; intraday strings become NY time.
- **Secrets.** No key in any file, log, or fixture.
- Findings need a concrete failure case. Mark each blocking or non-blocking. Attribute
  each to a worker or to CONTRACT.

Before the review, verify yourself: typecheck, lint, the full suite, and a mutation check
on at least one core rule per worker.

---

## 5. Wave 2 — integration (orchestrator)

### 5.1 Make the fundamentals mock use the real mapping
Write a script that runs W2's FMP provider over the recorded fixtures (stub the HTTP layer
to read fixture files) and writes contract-shaped JSON. Make `mocks/fundamentals.ts`
serve that JSON. Run W6's tests again. A failure here is drift between W2 and W6.

### 5.2 End-to-end against the real server
Start the server with `DATA_PROVIDER=synthetic` and a temporary `WORKSPACE_FILE`. With
real HTTP, check: the default workspace; create, update, conflict, and delete a layout;
create a watchlist and add symbols; `/api/quotes` for that watchlist; the three
fundamentals endpoints. Write the script to `scripts/` so the user can run it again.

### 5.3 The client against the real server
Run `npx vite build`. If a headless browser is available (for example Playwright), load
the app against the real server and check: the chart renders; the watchlist shows rows;
a row click changes the chart; a layout switch changes the chart; the Financials drawer
opens and shows data; earnings markers appear on the daily chart. If no headless browser
is available, write that in the report. Do not claim a browser check that you did not do.

### 5.4 Live FMP checks (only if `FMP_API_KEY` is set)
With `DATA_PROVIDER=fmp`: capabilities lists five timeframes; AAPL 5m bars start at
09:30 New York time; quotes for AAPL, MSFT, JPM, TSM, RIVN; the fundamentals overview for
AAPL, JPM, TSM, RIVN, and the "NM" rules apply to JPM margins and RIVN P/E. Spend fewer
than 150 API calls.

### 5.5 Fix round
Send each defect to the worker that owns the file. Verify each fix yourself.

---

## 6. Gate 6 — final review

One reviewer (`model: "opus"`) over the complete diff from `main`. Fix blocking findings.

---

## 7. Deliverables

1. Branch `phase-5`, pushed, with one commit for each worker and one for integration.
2. A pull request from `phase-5` to `main`. Write the description in ASD-STE100 style with
   the sections in `AGENTS.md`: Summary, Changes, Verification, Not verified, Risks.
3. `docs/PHASE5_REPORT.md`, in ASD-STE100 style: what each worker built, every gate
   finding and what happened to it, CONTRACT findings, test counts before and after, and
   a list of the decisions the user must make at review.

If you cannot finish, push what you have, open the PR as a draft, and write in the report
which parts are complete and which are not.
