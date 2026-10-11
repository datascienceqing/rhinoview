# RhinoView

RhinoView is a financial charting application. The client uses React, TypeScript, and
[Lightweight Charts](https://github.com/tradingview/lightweight-charts). A thin Fastify
proxy holds the API key and normalizes the upstream data.

## Features

- Symbol search, and candlestick, line, and area charts.
- Six timeframes: 1m, 5m, 15m, 1h, 1D, and 1W. The provider decides which ones it serves.
- Pan and zoom in two directions, with lazy load of older history.
- A crosshair OHLCV readout.
- SMA, EMA, RSI, and MACD indicators in synced panes.
- Earnings markers ("E") on the chart.
- Named layouts. Each layout keeps one chart: its symbol, timeframe, chart type, and indicators.
- Watchlists: many named lists, sort, drag to reorder, and delayed quotes. You can resize the sidebar.
- A Financials page: Overview, Statements, Trends, and Earnings.

The proxy keeps layouts and watchlists in one JSON file on the server (`WORKSPACE_FILE`).

## Data providers

The `DATA_PROVIDER` variable selects the provider:

| Provider | Key | Chart data | Financials |
|---|---|---|---|
| `synthetic` (default) | None | All six timeframes. The data is generated and deterministic. Use it for development and tests. | Generated data |
| `fmp` | `FMP_API_KEY` | See the table below. | Real data from FMP |
| `massive` | `MASSIVE_API_KEY` | Not implemented | Not available |

The FMP plan decides what the `fmp` provider can serve:

| FMP plan | Timeframes |
|---|---|
| Free | 1D and 1W only. All intraday endpoints return HTTP 402. |
| Starter | 5m, 15m, 1h, 1D, and 1W. The 1m endpoint returns HTTP 402, so RhinoView does not offer 1m. |

`GET /api/capabilities` tells what the active provider serves.

FMP data has some known problems. The header comments of `server/market/fmp/engine.ts` and
`server/fundamentals/types.ts` describe them. For example, FMP sometimes sends a fractional
intraday volume. The proxy rounds it to whole shares.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The proxy listens on port 8787. Vite listens on port 5173.

The default provider is `synthetic`, and it needs no key. To use real data, do these steps:

1. Put your FMP key in `FMP_API_KEY` in `.env`.
2. Set `DATA_PROVIDER=fmp` in `.env`.
3. Make sure that `.env` has `VITE_USE_MOCKS=false`. The example file has this value. If the value is not `false`, the browser uses the MSW mocks.

**Do not commit `.env`. Do not put a `VITE_` prefix on a key.** Vite puts every `VITE_`
variable into the browser bundle. Only `server/env.ts` reads the keys, and the keys never
go to the browser. The client calls same-origin `/api/*`. In development, Vite forwards
these calls to the proxy.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the proxy and the Vite dev server together |
| `npm run typecheck` | Runs `tsc --noEmit` on `shared/`, `server/`, and `src/` |
| `npm run lint` | Runs eslint |
| `npm test` | Runs vitest: the `client` project (jsdom) and the `node` project |
| `npm run build` | Runs the typecheck, then makes the production bundle |

The live FMP tests are skipped by default. To run them, use this command. It sends
approximately nine requests to FMP.

```bash
FMP_LIVE=1 npx vitest run --project node server/market/fmp/live
```

## Layout

```
shared/            Contract types for the client and the proxy. This is the single source of truth.
server/market/     Market data engines: synthetic and FMP
server/fundamentals/ Financials providers: synthetic and FMP
server/workspace/  The JSON store for layouts and watchlists
server/routes/     HTTP routes
server/provider/   Cache, errors, quotes, and fault injection
src/chart/         The lightweight-charts wrapper, panes, markers, and vertical pan
src/data/          The DataSource interface over the proxy contract
src/indicators/    Pure indicator math: SMA, EMA, RSI, and MACD
src/panes/         The indicator pane UI
src/workspace/     The client state for the active layout
src/layouts/       The layout switcher
src/watchlist/     The watchlist sidebar
src/fundamentals/  The Financials page
src/ui/            Symbol search, timeframe selector, legend, and sidebar resizer
mocks/             MSW handlers, and fixtures recorded from real upstream responses
```

## Documentation

- [`AGENTS.md`](AGENTS.md): Instructions for AI agents, and the ASD-STE100 output style.
- [`docs/MULTIAGENT_PLAN.md`](docs/MULTIAGENT_PLAN.md): The build plan, phases, and review gates.
- [`docs/CONTRACT.md`](docs/CONTRACT.md): The HTTP contract between the client and the proxy.
- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md): Shared context, file ownership, and known traps.
- [`docs/PHASE5_PLAN.md`](docs/PHASE5_PLAN.md): The plan for watchlists, layouts, and financials.
- [`docs/PHASE5_REPORT.md`](docs/PHASE5_REPORT.md): The Phase 5 report.

## License

Copyright (C) 2026 datascienceqing.

RhinoView is free software. You can redistribute it and change it under the terms of the
GNU Affero General Public License, version 3 or (at your option) any later version. See
[LICENSE](LICENSE).

The AGPL also covers use over a network. If you run a changed version of RhinoView as a
website or a service, you must offer its source code to its users.

RhinoView comes with NO WARRANTY, to the extent that the law permits.

Third-party parts keep their own licenses:

- TradingView Lightweight Charts: Apache-2.0. Read [NOTICE](NOTICE).
- The VRVP code ported from [Vela](https://github.com/datascienceqing/Vela): Apache-2.0.
  Each ported file names its source.
- The npm dependencies: their own licenses (MIT, BSD, ISC, Apache-2.0).

The test data in this repository is synthetic. It has the shape of real API responses,
but it holds no real market or company data.

## Attribution

RhinoView draws its charts with TradingView Lightweight Charts™. The on-chart logo of
the library is off. The credit in the application footer meets the link requirement of
the licence. Read [NOTICE](NOTICE) before you change the logo or the credit.

## Not in scope

RhinoView has no live WebSocket stream and no drawing tools. The data layer is behind a
`DataSource` interface. Thus, a stream can come later, with no change to the components.
