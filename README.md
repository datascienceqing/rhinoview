<div align="center">
  <table>
    <tr>
      <td>
        <i>There are wolves who know<br>
        There are sheep who don't know<br>
        There are Rhinos who have armor</i>
      </td>
      <td>
        <img src="docs/images/logo.svg" width="96" height="96" alt="RhinoView logo: a rhino head whose horn is a rising chart line">
      </td>
    </tr>
  </table>
</div>

<h1 align="center">RhinoView</h1>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

![RhinoView with AAPL on the daily chart, in the dark theme. Callouts show four points: 1, 1,000 alerts; 2, natural to use, with the right-click menu; 3, trade-proven indicators; 4, faster earnings updates, which depend on the data source](docs/images/app-en.png)

**New user? Read the [user guide](docs/USER_GUIDE.md).**

RhinoView is a financial charting application. The client uses React, TypeScript, and
[Lightweight Charts](https://github.com/tradingview/lightweight-charts). A thin Fastify
proxy holds the API key and normalizes the upstream data.

## Features

- Symbol search, and candlestick, line, and OHLC bar charts.
- Six timeframes: 1m, 5m, 15m, 1h, 1D, and 1W. The provider decides which ones it serves.
- Pan and zoom in two directions, with lazy load of older history.
- A crosshair OHLCV readout.
- SMA, EMA, RSI, and MACD indicators in synced panes.
- Volume, a visible-range volume profile (VRVP), and Liquidity zones and sweeps on the price pane.
- Earnings markers ("E") on the chart.
- Named layouts. Each layout keeps one chart: its symbol, timeframe, chart type, and indicators.
- Watchlists: many named lists, sort, drag to reorder, and quotes. You can resize the sidebar.
- A "Synthetic" badge in the header and the watchlist when the data is synthetic, so that nobody takes it for market prices.
- A Financials page: Overview, Statements, Trends, and Earnings.
- A dark theme and a light theme.
- An English interface and a Simplified Chinese interface. See [Languages](#languages).
- A chart menu: right-click the chart, or press Shift+F10. It adds an alert, and switches the theme and the language.
- Price alerts and indicator alerts (SMA, EMA, RSI, MACD), up to 1000, on any number of symbols.
  The server checks them. A fired alert shows a popup with a chime, and the bell keeps a log.

The proxy keeps layouts and watchlists in one JSON file on the server (`WORKSPACE_FILE`).
It keeps alerts and their log in a second file (`ALERTS_FILE`).

## Languages

The first visit uses the browser language: a `zh` browser gets Chinese, any other browser
gets English. The **中文 / EN** button in the toolbar changes the language. The browser
keeps the choice (`localStorage`, key `rhinoview:locale`).

The Chinese interface changes more than the text:

- Up is red and down is green, as in Chinese markets. English keeps green for up.
- Large numbers use 万 and 亿, for example 4676.81万 and 1.26亿.
- Dates on the time axis are Chinese, for example 6月 and 11日.
- Fiscal periods read 2026财年 and 2026财年Q1.
- The abbreviations MA, EMA, RSI, MACD, and VRVP do not change.

Data from the provider does not change: company names, descriptions, and sectors stay in
the provider's language. Some error messages come from the server, and they stay in English.

![RhinoView in Chinese and in the light theme: rises are red and falls are green. The callouts show the same four points in Chinese](docs/images/app-zh.png)

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
src/indicators/    Pure indicator math: SMA, EMA, RSI, MACD, Volume, VRVP, and Liquidity
src/panes/         The indicator pane UI
src/workspace/     The client state for the active layout
src/layouts/       The layout switcher
src/watchlist/     The watchlist sidebar
src/fundamentals/  The Financials page
src/ui/            Symbol search, timeframe selector, legend, sidebar resizer, and logo
src/i18n/          English and Chinese messages, the language toggle, and number formats
mocks/             MSW handlers, and fixtures recorded from real upstream responses
```

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) ([简体中文](docs/USER_GUIDE.zh-CN.md)): The user guide: the right-click menu, indicators, alerts, the call budget, and notifications.
- [`AGENTS.md`](AGENTS.md): Instructions for AI agents, and the ASD-STE100 output style.
- [`docs/MULTIAGENT_PLAN.md`](docs/MULTIAGENT_PLAN.md): The build plan, phases, and review gates.
- [`docs/CONTRACT.md`](docs/CONTRACT.md): The HTTP contract between the client and the proxy.
- [`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md): Shared context, file ownership, and known traps.
- [`docs/PHASE5_PLAN.md`](docs/PHASE5_PLAN.md): The plan for watchlists, layouts, and financials.
- [`docs/PHASE5_REPORT.md`](docs/PHASE5_REPORT.md): The Phase 5 report.
- [`docs/LIQUIDITY_PLAN.md`](docs/LIQUIDITY_PLAN.md): The specification of the Liquidity indicator.
- [`docs/ALERTS_PLAN.md`](docs/ALERTS_PLAN.md): The specification of the chart menu and the alerts.

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
the library is off. (This is the TradingView logo, not the RhinoView rhino.) The credit
in the application footer meets the link requirement of the licence. Read
[NOTICE](NOTICE) before you change the TradingView logo setting or the credit.

## Not in scope

RhinoView has no live WebSocket stream and no drawing tools. The data layer is behind a
`DataSource` interface. Thus, a stream can come later, with no change to the components.
