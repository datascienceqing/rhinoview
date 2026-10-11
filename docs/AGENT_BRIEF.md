# Agent Brief — read this first, every time

Shared context for every worker and reviewer on this project. Read it before
touching code, then read [`docs/CONTRACT.md`](./CONTRACT.md) and
[`shared/types.ts`](../shared/types.ts).

---

## What this project is

A TradingView-style charting application. React + TypeScript front end built on
TradingView's open-source **lightweight-charts** library, backed by a thin Fastify
proxy that holds the massive.com API key and normalizes upstream data.

**v1 scope:** symbol search, candlestick/line/area charts, timeframe switching,
pan/zoom with lazy history loading, crosshair OHLCV readout, and SMA/EMA/RSI/MACD
indicators.

**Explicitly out of v1:** live WebSocket streaming, drawing tools. Do not build
them, do not stub them, do not add "future" abstractions for them beyond the
`DataSource` interface that already exists for that purpose.

---

## File ownership — do not cross these lines

Each worker writes **only** inside its own paths. If your task seems to require
editing another worker's file, **stop and report it** instead. A cross-boundary edit
is worse than a blocked task: it lands in a tree someone else is editing concurrently.

| Path | Owner |
|---|---|
| `shared/**` | **Orchestrator — frozen.** Report problems, never edit. |
| `docs/**` | **Orchestrator — frozen.** |
| `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js` | **Orchestrator — frozen.** Every dependency you need is already installed. |
| `server/env.ts` | **Orchestrator — frozen.** Only place the API key is read. |
| `server/market/types.ts` | **Orchestrator — frozen.** The engine seam + its invariants. |
| `server/market/**` (except `types.ts`) | Worker A1 — synthetic data engine |
| `server/provider/**`, `server/routes/**`, `server/cache/**`, `server/index.ts` | Worker A2 — HTTP layer |
| `src/chart/**`, `src/data/**`, `src/ui/**`, `mocks/**` | Worker B |
| `src/App.tsx`, `src/styles.css`, `src/test-setup.ts` | Worker B (it builds the shell) |
| `src/indicators/types.ts` | **Orchestrator — frozen.** The C↔D seam and its conventions. |
| `src/indicators/**` (except `types.ts`) | Worker C — indicator math |
| `src/panes/**` | Worker D — indicator pane UI |
| `src/chart/**`, `src/ui/ChartPanel.tsx` | Worker D may extend these to wire panes in (Worker B is finished) |
| `src/main.tsx`, `index.html` | Orchestrator — request changes, don't make them |

**Need a new dependency?** Stop and ask. Do not run `npm install` — concurrent
installs corrupt the lockfile for whoever else is running.

---

## Phase 5 file ownership

Phase 5 replaces the ownership table above for the duration of the phase. The full task
for each worker is in `docs/PHASE5_PLAN.md`, section 3.

| Path | Owner |
|---|---|
| Everything in `docs/PHASE5_PLAN.md` section 2 (wave 0 seams, `src/App.tsx`, `mocks/workspace.ts`, `mocks/envelope.ts`, fixtures) | **Orchestrator — frozen** |
| `server/market/fmp/**`, `server/routes/quotes.ts`, `server/provider/quotes.ts`, `server/cache/quotesCache.ts` | W1 — FMP intraday and batch quotes |
| `server/fundamentals/**` (not `types.ts`), `server/routes/fundamentals.ts` | W2 — fundamentals |
| `server/workspace/**` (not `types.ts`), `server/routes/workspace.ts` | W3 — workspace store |
| `src/layouts/**`, `src/workspace/**` (not `types.ts`), `src/ui/ChartPanel.tsx`, `src/ui/TimeframeSelector.tsx`, `src/panes/storage.ts` | W4 — named layouts |
| `src/watchlist/**`, `mocks/quotes.ts` | W5 — watchlist |
| `src/fundamentals/**`, `mocks/fundamentals.ts` | W6 — financials and earnings markers |

Two sanctioned cross-boundary imports exist. W3 imports `checkIndicatorParams` from
`src/indicators/params.ts`, so server and client validate indicators the same way. W5
imports (does not edit) `SymbolSearch` from `src/ui`.

## Where the data comes from

**There is no market-data subscription.** A deterministic **synthetic engine** stands
in for one, selected by `DATA_PROVIDER=synthetic` (the default — the server boots with
no credentials). A real massive.com client will later implement the same
`MarketEngine` interface behind the same `DATA_PROVIDER` switch.

This changes nothing above the engine seam. The HTTP contract in
[`docs/CONTRACT.md`](./CONTRACT.md) is unchanged, and the client cannot tell the
difference — which is the point, and also the test: if any client code needs to know
the data is synthetic, the seam leaked.

The seam and its seven invariants are in
[`server/market/types.ts`](../server/market/types.ts). Read them before writing engine
or provider code. Invariant 2 — cross-timeframe coherence — is the hard one and the
one the reviewer will press on.

Upstream massive.com specifics are retained in trap #5 and #6 below and in
`docs/CONTRACT.md` for whoever eventually writes the real client. They do not apply
to the synthetic engine.

## Commands

```bash
npm run typecheck     # tsc --noEmit across shared/, server/, src/ — must be clean
npm run lint          # eslint — must be clean
npm test              # vitest, both projects
npm run dev           # proxy + Vite together
```

`npm test` runs two projects: `client` (jsdom, `src/**/*.test.tsx?`) and `node`
(node, `server/**` and `shared/**`). Putting a server test under `src/` silently
gives it a DOM; keep tests next to the code they cover.

**Your task is not done until `npm run typecheck`, `npm run lint`, and `npm test`
all pass.** Run them yourself and paste the real output in your report. A report
claiming green without output will be sent back.

---

## Code standards

- **TypeScript is strict**, including `noUncheckedIndexedAccess`. `bars[i]` is
  `Bar | undefined`, so index access needs a guard or a non-null assertion you can
  justify. This is deliberate: it catches exactly the off-by-one errors that
  indicator warmup windows are prone to. Do not weaken the config to avoid it.
- `verbatimModuleSyntax` is on — use `import type { … }` for type-only imports.
- Import shared types as `import type { Bar } from '@shared/types'`.
- No `any`. No non-null assertion on something that can legitimately be absent —
  handle it. No `@ts-expect-error` without a comment saying why.
- Comment density: match the surrounding file. Explain *why*, not *what*.
- Tests state behaviour, not implementation: `it('returns null during warmup')`,
  not `it('works')`.

---

## Traps specific to this stack

### 1. Milliseconds vs seconds — the blank-chart bug

massive.com returns bar timestamps (`t`) in **Unix milliseconds**.
lightweight-charts' `UTCTimestamp` is **Unix seconds**. The entire contract is in
seconds, converted once in `server/massive/`.

Feed milliseconds to lightweight-charts and you get a chart that renders with no
error and no visible candles, because every bar sits ~55,000 years in the future.
There is no exception thrown and nothing in the console. If a chart is blank, check
this first.

### 2. lightweight-charts v5 API — not v4

Installed version is **5.2.1**. The v4 `chart.addCandlestickSeries()` style is gone.
Verified against the installed typings:

```ts
import { createChart, CandlestickSeries, LineSeries, HistogramSeries } from 'lightweight-charts';

const chart = createChart(container, { /* options */ });

// v5: pass a series *definition*, plus an optional pane index.
const price = chart.addSeries(CandlestickSeries, { upColor: '#26a69a' });
const rsi   = chart.addSeries(LineSeries, { color: '#2962ff' }, 1); // ← pane 1

// Panes:
chart.addPane();        // append a pane
chart.panes();          // IPaneApi[]
chart.removePane(1);
```

That third `paneIndex` argument to `addSeries` is the whole multi-pane mechanism —
Worker D needs it for RSI and MACD. If you find yourself building synchronized
separate chart instances, you are solving a problem the library already solved.

### 3. Chart disposal

`createChart` allocates a canvas and attaches listeners. Call `chart.remove()` in the
effect cleanup, and never touch a series API after its chart is removed — it throws
on a disposed object. Under React 18 StrictMode (which is on in `main.tsx`), every
effect mounts, unmounts, and remounts in dev, so a missing cleanup shows up
immediately as a doubled chart or a disposed-object error. That is the dev loop doing
you a favour, not a bug to work around.

### 4. Indicator warmup is `null`, never `0`

An SMA(20) has no value for the first 19 bars. `IndicatorPoint.value` is
`number | null` and must be `null` there. Emitting `0` draws a real line at zero and
misleads the reader — the one thing a charting app must never do.

### 5. Upstream pagination truncates silently

Upstream's default `limit` is 5,000 and its max is 50,000. Ask for a year of minute
bars and you get a partial series with no error. Follow `next_url` to exhaustion or
report `truncated: true`. `next_url` comes back **without** the API key attached.

### 6. Delayed vs real-time tiers

Depending on plan tier, a provider serves delayed data. `Snapshot.delayed` must reflect
reality. The UI does not badge delayed data (user decision, 2026-10-11). It badges
SYNTHETIC data instead (`Capabilities.provider` is `synthetic` or `mock`), so that nobody
takes generated prices for market prices.

### 7. The API key is server-side only

It is read in exactly one place, `server/env.ts`. Never reference `process.env` in
`src/**` — eslint blocks it. Never name a variable `VITE_*` for anything secret;
Vite inlines `VITE_`-prefixed env vars into the browser bundle. Never log a URL that
has the key in its query string; use `redact()`.

---

## Reporting back

When you finish, report:

1. **What you built** — one short paragraph, not a file-by-file tour.
2. **Real command output** for typecheck, lint, and tests. Paste it.
3. **Contract deviations** — anything you could not implement as specified, and why.
   This is the highest-value part of your report. Say it plainly; it is not a failure
   to report a contract problem, it is the job.
4. **Known gaps** — what you deliberately left out and why.
5. **Anything you discovered about upstream** that contradicts this brief.

Do not claim something works if you did not run it. Your output goes to an Opus 5.5
reviewer with read-only access that will check the claims against the diff, and the
orchestrator runs the commands independently at every gate. An honest "I couldn't
verify X" costs nothing; an unverified green claim costs a review round.
