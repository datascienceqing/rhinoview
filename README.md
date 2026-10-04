# RhinoView

A financial charting application. React + TypeScript on
[Lightweight Charts](https://github.com/tradingview/lightweight-charts), backed by a
thin Fastify proxy that holds the market-data API key and normalizes upstream data.

Market data comes from a `MarketEngine` provider chosen by `DATA_PROVIDER`:

| Provider | Needs a key | Serves |
|---|---|---|
| `synthetic` (default) | no | All six timeframes, deterministic — used for development and tests |
| `fmp` | `FMP_API_KEY` | Real `1D` and `1W`. Intraday is a paid tier; the free tier returns HTTP 402 |
| `massive` | — | Not implemented |

`GET /api/capabilities` reports what the active provider actually serves.

## Attribution

Charts are rendered with TradingView Lightweight Charts™. The library's on-chart
logo is disabled; the licence's linking requirement is met by the credit in the
application footer. See [NOTICE](NOTICE) before changing either.

## Setup

```bash
npm install
cp .env.example .env    # then put your massive.com key in MASSIVE_API_KEY
npm run dev             # proxy on :8787, Vite on :5173
```

The API key is read in exactly one place — `server/env.ts` — and never reaches the
browser. The client calls same-origin `/api/*`, which Vite forwards to the proxy in
development.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Proxy + Vite dev server together |
| `npm run typecheck` | `tsc --noEmit` over `shared/`, `server/`, `src/` |
| `npm run lint` | eslint |
| `npm test` | vitest — `client` (jsdom) and `node` projects |
| `npm run build` | typecheck, then production bundle |

## Layout

```
shared/        Contract types shared by client and proxy — the single source of truth
server/        Fastify proxy: routes, upstream client, cache, key handling
src/chart/     lightweight-charts wrapper, panes, time-scale sync
src/data/      DataSource interface over the proxy contract
src/indicators/ Pure indicator math: SMA, EMA, RSI, MACD
src/panes/     Indicator pane UI
src/ui/        Symbol search, timeframe selector, legend, layout
mocks/         MSW handlers + fixtures recorded from real upstream responses
```

## Documentation

- [`docs/MULTIAGENT_PLAN.md`](docs/MULTIAGENT_PLAN.md) — build plan, phases, review gates
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — the client ↔ proxy HTTP contract
- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) — shared context, ownership, known traps

## Scope

**In v1:** symbol search, candlestick/line/area, timeframe switching, pan/zoom with
lazy history, crosshair OHLCV readout, SMA/EMA/RSI/MACD indicators in synced panes.

**Not in v1:** live WebSocket streaming, drawing tools. The data layer sits behind a
`DataSource` interface so a streaming implementation can land later without touching
components.
