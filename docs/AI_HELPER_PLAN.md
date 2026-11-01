# Plan — AI helper and AI alerts

Status: approved by the user (2026-10-31), with the recommendations for D1–D6. Step A done (2026-10-31): `server/ai/facts/`. Step B done (2026-10-31): `POST /api/ai/analyze`. Step C done (2026-10-31): the AI panel and the chart marks, branch `feat/ai-panel`. Step D done (2026-10-31): AI alerts, same branch.
Branch: `feat/ai-helper-skills`.

**Implementer:** read `AGENTS.md` first. All output for the user (reports, commit messages,
the PR) must be in ASD-STE100 style.

## 1. Goal

1. **AI analysis.** The user asks a question about the chart. The server calculates the facts,
   DeepSeek writes the answer with the `trade-check` skill, and the chart shows the levels.
2. **AI alerts.** A right-click item "AI alerts…" runs the analysis for the symbol on the
   chart. The server makes alerts from the plan levels. It adds each valid alert, and it
   tells the user why it rejected the other alerts.
3. **Explain a fired alert.** When an AI alert fires, the user clicks "Explain". The agent
   tells what happened, whether the plan is still valid, and what the next step of the plan is.

## 2. State today

Done on this branch:

- The `trade-check` skill (`server/ai/skills/trade-check.md`), version 0.5.0.
- Five samples with audits (`docs/ai-samples/`).
- Backtests of the stop, MA, volume, and management rules (`docs/ai-samples/BACKTEST_REPORT.md`).
- The chart menu has only the add-alert items. Theme, language, and Financials are in the toolbar only.

- Step A: the facts builder in `server/ai/facts/`, with unit tests.
- Step B: the DeepSeek client, the facts loader, the number check, and `POST /api/ai/analyze` (streamed).

- Step C: the AI panel (`src/ai/`), the toolbar button, and the chart marks (`src/chart/AiZonesPrimitive.ts`). The chart draws one featured plan for each side (entry, stop, T1, T2) and the 4 nearest zones.
- Step D: "AI alerts…" on the chart menu, `POST /api/ai/alerts`, `Alert.origin`, and the analyses store.

Not done: no explanation of a fired alert (step E).

Change from the plan in step D: the alerts endpoint makes no DeepSeek call. The plans are already calculated, so a model call adds cost and time but no level. Step E uses the model to explain a fired alert.

## 3. Rule: the server calculates, the model explains

The samples had many arithmetic errors: wrong R:R, wrong counts, "below" for "above". So:

- The server calculates every number: levels, distances, R:R, the confluence count, the plans.
- DeepSeek receives `facts` as JSON and writes text only.
- The server checks the answer before it shows it. Each number in the text must be in
  `facts` (with a small rounding tolerance). An unknown number gets a warning mark in the UI.
- The server makes the chart marks and the alerts from `facts`, not from the model text.

## 4. Steps

### Step A — facts builder (`server/ai/facts/`)

Build the `facts` object that the skill describes. The server imports the indicator math
from `src/indicators/` (the same sanctioned import as `checkIndicatorParams`).

| Part | State |
|---|---|
| Bars 4H, 1D, 1W; quote; recent move | Available |
| EMA20/50/200, RSI, MACD, ATR, pivots, FVG, liquidity | Available in `src/indicators/` |
| 1M bars | New: aggregate from 1W |
| ADX, Bollinger bands, rating score | New |
| BOS and CHoCH, range and equilibrium, fib levels, order blocks | New |
| Volume signals (capitulation, dry-up) | New |
| Confluence rows and count | New |
| Plans: entry, invalidation, stop, T1–T3, R:R, size | New. Uses the rules in the skill |
| Analysts, earnings, news | Available. Peers and the quarter label are new |

Each new calculation gets unit tests, like the other indicators.

### Step B — DeepSeek and the analysis endpoint

- `server/env.ts`: add `DEEPSEEK_API_KEY` (optional) and `DEEPSEEK_MODEL` (default `deepseek-chat`).
- `server/ai/deepseek.ts`: a client with the same key rules as the FMP client. The key is never logged.
- `POST /api/ai/analyze` `{ symbol, timeframe, question }` → a streamed answer, then `facts`, `marks`, and the number check.
- `GET /api/capabilities` gets `ai: boolean`. Without a key, the UI hides all AI items.
- A daily limit on DeepSeek calls (setting `AI_DAILY_CALL_LIMIT`).

### Step C — AI panel and chart marks

- A panel beside the chart: a question box, the answer, and the warning marks from the number check.
- A chart layer for `marks`: price lines and zones. It is separate from the user drawings.
- The marks stay until the user clears them or changes the symbol.

### Step D — AI alerts

1. The chart menu gets "AI alerts…" on the price pane. It is the first item.
2. The server runs the analysis with `direction: null` and the question "Which alerts are useful now?".
3. The server makes alert candidates from the plans:

   | Plan level | Alert | Message |
   |---|---|---|
   | Entry trigger | Price crosses the trigger in the trigger direction | "Entry trigger of plan A: …" |
   | Invalidation | Price crosses the invalidation level | "Plan A is not valid any more" |
   | T1 | Price crosses T1 | "T1 of plan A: take half off" |

4. The server checks each candidate. A candidate is **valid** when all of these are true:
   - Price is on the correct side of the level now. The alert has not already crossed.
   - The level is 3 × ATR(1D) from price or nearer.
   - The plan of the entry alert has R:R of 2:1 or more to T2.
   - The user has no alert at the same level (within 0.1 × ATR) on this symbol.
   - The expiry is before the next earnings date, or the alert message names the earnings date.
5. The server adds each valid alert with the existing alerts store. Each alert gets
   `origin: { kind: 'ai', analysisId }`.
6. The UI shows the result: the added alerts (each with "Remove") and the rejected candidates with the reason.

### Step E — explain a fired alert

1. The server saves each analysis (facts, answer, plans) in `data/ai/analyses.json`. The file is gitignored.
2. An `AlertEvent` from an AI alert gets the `analysisId`.
3. The toast and the Alerts window show "Explain" for these events.
4. "Explain" calls `POST /api/ai/explain` `{ eventId }`. The server builds new facts at the
   fire time and sends them with the saved analysis to DeepSeek, with a new skill, `alert-explain`.
5. The answer tells:
   - What happened: a close through the level, or only a wick. The volume ratio.
   - If the plan is still valid. If not, which condition failed.
   - The next step of the plan: entry, take half off, move the stop, or cancel.
   - What changed since the analysis: new structure events, news, earnings.

The `alert-explain` skill needs samples. The user gives them before step E.

## 5. Frozen files

These changes touch files that `AGENTS.md` marks as frozen. The user must approve them:

- `server/env.ts`: `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `AI_DAILY_CALL_LIMIT`.
- `shared/types.ts`: `Capabilities.ai`, `Alert.origin`, `AlertEvent.analysisId`, the AI request and response types.
- `docs/CONTRACT.md`: the endpoints `/api/ai/analyze` and `/api/ai/explain`.

## 6. Decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Add valid AI alerts at once, or ask the user first | At once, with "Remove" on each (the user asked for this) |
| D2 | Write the explanation when the alert fires, or when the user clicks "Explain" | On click: no cost for alerts that nobody reads |
| D3 | DeepSeek model | `deepseek-chat`. `deepseek-reasoner` is slower and costs more |
| D4 | Approve the frozen file changes in section 5 | Yes |
| D5 | Daily limit on DeepSeek calls | 50 |
| D6 | Order of the steps | A, B, C, D, E. Each step is one PR |

## 7. Not in scope

- Automatic trades. The agent never places an order.
- AI alerts on indicators. Step D uses price alerts only. The existing alert types can do more later.
- Other skills (support, earnings, take profit). They need samples first.
