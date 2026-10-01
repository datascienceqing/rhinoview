# Multiagent Build Plan — TradingView-style Charting App

**Project:** `~/projects/charting-app`
**Data source:** massive.com (REST + WebSocket market data; Polygon.io-compatible API surface)
**Worker model:** Claude Sonnet 5.5 (`model: "sonnet"`)
**Reviewer model:** Claude Opus 5.5 (`model: "opus"`)
**Orchestrator:** Claude Opus 5 (this session)

> Model note: Opus 4.6 does not exist. The current lineup is Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 4.5. This plan uses Opus 5.5 as reviewer, which is the role you asked for.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Chart renderer | TradingView **lightweight-charts** (Apache-2.0), with the app shell built around it |
| v1 scope | Core charting **+** technical indicators |
| Out of v1 | Live WebSocket streaming, drawing tools |
| Repo | New git repo at `~/projects/charting-app` |
| Backend | Thin proxy server holding the API key; browser never sees it |
| Package manager | `npm` (local pnpm is 7.5.2, too old to bother with) |
| **Data source** | **Deterministic synthetic engine** behind a `MarketEngine` seam — no subscription available. Real massive.com client implements the same interface later, selected by `DATA_PROVIDER`. |

Streaming and drawing tools are deliberately deferred, but the data layer in Phase 1 is shaped so a WebSocket source drops in behind the same interface later.

---

## Stack

```
charting-app/
├── shared/           # Contract types — single source of truth, orchestrator-owned
│   └── types.ts
├── server/           # Fastify + TS proxy. Holds MASSIVE_API_KEY.
│   ├── routes/
│   ├── massive/      # Upstream client, pagination, backoff, LRU cache
│   └── test/
├── src/              # Vite + React + TS front end
│   ├── chart/        # lightweight-charts wrapper, panes, time-scale sync
│   ├── data/         # Fetch layer against the proxy contract
│   ├── indicators/   # Pure computation: SMA, EMA, RSI, MACD
│   ├── panes/        # Indicator pane UI, parameter editors
│   └── ui/           # Symbol search, timeframe selector, legend, layout
├── mocks/            # MSW handlers + recorded fixtures
└── docs/
    ├── MULTIAGENT_PLAN.md
    ├── CONTRACT.md
    └── AGENT_BRIEF.md
```

---

## Why this shape of fleet

Multiagent builds fail in four predictable ways. Each phase below is arranged to close one:

1. **Contract drift** — parallel workers invent incompatible interfaces. Closed by writing `shared/types.ts` and `docs/CONTRACT.md` myself, before any agent spawns, and gating every phase on `tsc --noEmit` across the whole repo.
2. **File collisions** — two agents editing `package.json` or the lockfile at once. Closed by installing every dependency in Phase 0, so no worker ever touches manifests.
3. **Self-reported success** — a worker says "done, all tests pass" having run nothing. Closed by the orchestrator running typecheck, tests, and the actual browser at every gate. No gate passes on an agent's word.
4. **Reviewer-as-rewriter** — the review agent starts editing and you lose the independent check. Closed by giving the reviewer a read-only toolset and routing fixes back to the worker that wrote the code, via `SendMessage`, so it still has its context.

Parallelism is only used where **file ownership is strictly disjoint**. Agents sharing the working tree is fine under that rule and avoids worktree-merge friction.

---

## Phase 0 — Contracts and scaffold (orchestrator only, no agents)

Nothing spawns until this is done. This is the phase that determines whether the rest works.

1. `git init`, Vite + React + TS scaffold, Fastify server scaffold.
2. Install **all** dependencies up front: `lightweight-charts`, `fastify`, `zod`, `undici`, `lru-cache`, `vitest`, `msw`, `@testing-library/react`, `tsx`, `concurrently`.
3. Write `shared/types.ts` — `Bar`, `Ticker`, `SearchResult`, `Timeframe`, `IndicatorSeries`, `ApiResult<T>`, `ApiError`.
4. Write `docs/CONTRACT.md` — the exact HTTP contract between client and proxy:
   - `GET /api/search?q=` → `SearchResult[]`
   - `GET /api/bars?symbol=&timeframe=&from=&to=` → `Bar[]`
   - `GET /api/snapshot?symbol=` → `Snapshot`
   - `GET /api/indicator?symbol=&kind=&params=` *(oracle/debug only — see Phase 3)*
   - Error envelope, pagination semantics, cache headers.
5. Write `docs/AGENT_BRIEF.md` — the shared context every worker reads first: coding standards, test commands, **file ownership boundaries**, and the massive.com traps listed below.
6. **Verify the upstream API by hand with `curl`**, using a real key, before writing a line of client code. Confirm: auth mechanism (`apiKey` query param vs `Authorization: Bearer` — docs are ambiguous, so this gets settled empirically), the real response shape, and which plan tier the key has (delayed vs real-time changes what "live" means).
7. Record fixtures from those real responses into `mocks/fixtures/`.

**Gate 0 (revised):** no subscription is available, so the original gate — a real `curl`
returning real bars — cannot be met and has been replaced. The engine seam
`server/market/types.ts` is frozen with explicit invariants, contract-valid fixtures
are on disk, and the server boots and answers `/api/health` with **no credentials
configured**. Verified.

The risk the original gate protected against has moved rather than vanished: instead of
"is our assumption about upstream auth right?", it is now "does the synthetic engine
behave enough like a real market that code written against it survives contact with a
real feed?" That is what invariants 2 and 3 in the seam exist to force, and what the
eventual `DATA_PROVIDER=massive` implementation will test.

### massive.com specifics that go in the brief

- Bars: `GET https://api.massive.com/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`
  Params: `adjusted` (default `true`), `sort` (`asc`/`desc`), `limit` (max 50,000, default 5,000).
  Response: `results[]` of `{ o, h, l, c, v, vw, n, t }`, plus `next_url` for pagination.
- **`t` is Unix milliseconds. lightweight-charts wants seconds** (`UTCTimestamp`) for intraday, and `'YYYY-MM-DD'` strings for daily. This single mismatch is the most likely source of a silently blank chart — it is called out explicitly in the brief and gets a unit test.
- Default `limit` of 5,000 will silently truncate long ranges. Pagination via `next_url` is mandatory, not optional.
- Symbol search: `/rest/stocks/tickers/all-tickers`. Snapshot: `/rest/stocks/snapshots/single-ticker-snapshot`.
- Indicator endpoints (SMA/EMA/MACD/RSI) exist upstream and are used as a **test oracle**, not as the runtime source.
- Rate limits are tier-dependent; the proxy owns 429 handling with exponential backoff and jitter, and surfaces a typed error the UI can render.

---

## Phase 1 — Proxy + chart shell (2 workers, parallel)

Both run against the same contract. Neither waits for the other, because the front end builds against MSW handlers generated from the Phase 0 fixtures. Integration becomes a merge, not a rewrite.

### Worker A1 — Synthetic market engine · Sonnet 5.5
**Owns:** `server/market/**` except the frozen `types.ts`.

Implements `MarketEngine`: one deterministic minute-level price path per symbol,
bucketed into whatever timeframe is requested, over a correct US equity session
calendar. Pure and dependency-free — no HTTP, no caching, no env access beyond the
delayed flag. The seven invariants in `server/market/types.ts` are the acceptance
criteria, and **invariant 2, cross-timeframe coherence, is the hard one**: 5m bars must
aggregate exactly into 1h, 1h into 1D, 1D into 1W. Generating each timeframe
independently cannot satisfy it, and switching timeframes would then show
contradictory prices for the same instant.

This is the Phase 1 analogue of Worker C: pure, numerically fussy, independently
testable. It gets its own worker for the same reason.

### Worker A2 — HTTP layer · Sonnet 5.5
**Owns:** `server/provider/**`, `server/routes/**`, `server/cache/**`, `server/index.ts`.

- Implement the four contract endpoints.
- `server/massive/` client: key injection, `next_url` pagination, LRU cache keyed by `symbol+timeframe+range`, 429/5xx retry with backoff + jitter, request timeouts.
- `zod` validation on every inbound query and every upstream response. An upstream shape change should fail loudly at the boundary, not produce `NaN` candles.
- Normalize `t` ms → the contract's timestamp format at the server edge, once, so the client never deals with two time units.
- `vitest` suite against the recorded fixtures. No network in tests.

**Acceptance:** all four endpoints return contract-valid payloads from fixtures; cache hit/miss and 429 backoff both covered by tests; `tsc --noEmit` clean.

### Worker B — Chart shell · Sonnet 5.5
**Owns:** `src/chart/**`, `src/data/**`, `src/ui/**`, `mocks/handlers.ts`.

- lightweight-charts wrapper: candlestick + line + area series, proper disposal on unmount, resize observer.
- Timeframe selector (1m / 5m / 15m / 1h / 1D / 1W) mapping to `multiplier`+`timespan`.
- Symbol search with debounce and keyboard nav.
- Crosshair legend showing O/H/L/C/V for the hovered bar.
- Pan/zoom, with lazy-loading of older bars on left-edge scroll.
- Loading, empty, error, and "market closed" states — designed in, not bolted on.
- `src/data/` behind a `DataSource` interface, so a WebSocket implementation can land later without touching components.

**Acceptance:** app renders a full chart from MSW fixtures, timeframe switching works, no console errors, component tests pass, `tsc --noEmit` clean.

### Gate 1 — Reviewer · Opus 5.5 (read-only)

Reviews **all three diffs together** (A1, A2, B), which is the point — the one thing a per-worker review cannot catch is drift between them.

Focus: contract conformance on all sides · timestamp handling end to end · **the engine's cross-timeframe coherence invariant** · session-calendar correctness across a DST boundary · resource leaks in the chart wrapper (lightweight-charts needs explicit `remove()`) · error paths that silently swallow · anything hardcoded that should be contract-driven.

Output: findings ranked by severity, each with a concrete failure scenario, marked blocking or non-blocking. Fixes routed back to the originating worker by `SendMessage`. Max 2 rounds; a third escalates to me.

---

## Phase 2 — Real integration (orchestrator + 1 worker)

1. Swap MSW for the live proxy.
2. Fix the mismatches that static fixtures hide — half-days, session gaps, splits under `adjusted=true`, thinly-listed symbols. The synthetic engine generates all of these on demand, which is strictly better for this phase than a fixture set: the edge cases are reachable deliberately rather than whenever the market happens to produce one.
3. **I verify in the browser myself** — built-in browser pane, screenshot, console and network panels — rather than accepting a worker's "it works."

**Gate 2:** daily and 5-minute candles render from the live proxy, clean console, and the network tab shows the client calling only same-origin `/api/*` — no credentials and no upstream URL in the browser.

---

## Phase 3 — Indicators (2 workers, parallel)

Computation is **client-side**, not pulled per-render from massive. Three reasons: no API quota burned per indicator, parameter changes are instant, and it keeps working while panning through cached bars.

### Worker C — Indicator math · Sonnet 5.5
**Owns:** `src/indicators/**`.

- Pure functions, `Bar[]` in → `IndicatorSeries` out. Zero React, zero DOM.
- SMA, EMA, RSI (**Wilder smoothing**), MACD (12/26/9, with correct EMA seeding).
- Explicit warmup handling: the first *n* points are undefined, not zero. Zeros here draw a visible lie on the chart.
- **Oracle tests:** compare each function's output against massive.com's own SMA/EMA/MACD/RSI endpoints for a real symbol, with a documented tolerance. This is a much stronger correctness check than hand-written expectations, and it's the reason those endpoints are in the contract at all.

**Acceptance:** all four match the upstream oracle within tolerance; warmup and short-series edge cases tested; pure and dependency-free.

### Worker D — Indicator pane UI · Sonnet 5.5
**Owns:** `src/panes/**`, plus named additions to `src/ui/` coordinated through me.

- Add/remove indicators; overlay (SMA/EMA on price) vs separate pane (RSI/MACD).
- Parameter editor with live recompute.
- **Time-scale sync across panes** — the thing that makes a multi-pane chart feel like TradingView rather than three stacked charts.
- Per-pane crosshair legend values.
- Indicator config persisted to `localStorage`, keyed by symbol.

**Acceptance:** RSI and MACD render in synced sub-panes; SMA/EMA overlay on price; parameter edits recompute without a full chart rebuild; panes dispose cleanly.

### Gate 3 — Reviewer · Opus 5.5 (read-only)

Focus: **numerical correctness** — Wilder vs simple smoothing in RSI, MACD signal-line seeding, off-by-one in warmup windows, `NaN`/`undefined` leaking into series data · pane sync under rapid timeframe changes · recompute performance on 50k bars · memory growth when adding/removing indicators repeatedly.

---

## Phase 4 — Hardening (1 worker + final review)

- Invalid symbol, zero-result search, rate-limit UX, network-loss recovery.
- Keyboard shortcuts; perf pass at 50,000 bars (target: 60fps pan).
- `README.md` with real setup steps; `.env.example`; **verify no key in git history**.
- Final Opus 5.5 review over the complete diff.

**Gate 4:** full app verified by me in the browser; typecheck, lint, and all tests green on a clean clone.

---

## Review protocol

- Reviewer receives the **diff**, the contract, and that phase's acceptance criteria — not the whole repo. Scoped input produces specific findings.
- Reviewer **never edits**. Read-only tools only.
- Fixes go to the worker that wrote the code via `SendMessage`, preserving its context. A fresh spawn would re-derive everything and cost more for a worse result.
- Max 2 review rounds per phase. Round 3 means the phase was mis-scoped and comes back to me.
- Reviewer reports are not shown to you directly — I relay what matters.

## Orchestration budget

| | Spawns | Model |
|---|---|---|
| Implementation workers | 6 (+ ~4 `SendMessage` continuations) | Sonnet 5.5 |
| Review gates | 4 | Opus 5.5 |
| Contracts, integration, browser verification | — | Opus 5 (this session) |

Phases 1 and 3 run two workers concurrently; everything else is serial. Four hard gates, each verified by me running real commands and a real browser.

## Critical path

```
Phase 0 (contracts + verified API key)
   └─> Phase 1  [A: proxy ‖ B: chart shell]  ──> Gate 1 (Opus)
         └─> Phase 2 (live integration)      ──> Gate 2 (browser, me)
               └─> Phase 3 [C: math ‖ D: panes] ──> Gate 3 (Opus)
                     └─> Phase 4 (hardening)  ──> Gate 4 (Opus + browser)
```

Phase 0 is the single point of failure for everything after it. It is also the cheapest phase to get right, which is why no agent spawns until its gate passes.
