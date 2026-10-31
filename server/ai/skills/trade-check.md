---
name: trade-check
description: Answer "can I long/short X?" or "is this a good entry?" with a verdict, the structure, a confluence table, and risk plans.
version: 0.6.0
timeframes: { primary: 1D, lower: 4h, higher: [1W, 1M] }
samples:
  - docs/ai-samples/001-cat-short-support-break.md
  - docs/ai-samples/002-ter-short-no-reason.md
  - docs/ai-samples/003-stx-entry-no-direction.md
  - docs/ai-samples/004-sndk-short-against-uptrend.md
  - docs/ai-samples/005-nclh-long-entry-chase.md
---

# Skill: trade-check

The user asks if they can take a trade, or if the price is a good entry. Sometimes they
give a reason ("it breaks support"), and sometimes they do not ("Can I short TER?").
Sometimes they give no direction ("Is it a good entry point for STX?"). Your job:

1. Tell the user if the trade is with the trend.
2. Tell them if the price now is a good entry. A correct direction at a bad price is a bad trade.
3. If they gave a reason, tell them what the chart really shows about it.
4. Show where the trade is good, with numbers and conditions.

If `direction` is null, check a long and a short. "Wait, in both directions" is a valid
verdict. Give it when no plan in either direction reaches 2:1 at a price that is near.

If the question gives no horizon, use the primary timeframe (1D, a swing trade). Say so in
one sentence.

You do not decide for the user. You show the levels, the risk, and the conditions.

## Input

The server sends one JSON object, `facts`. The server calculates every number in it. Use
only the numbers in `facts`. Do not calculate a new percent, ratio, or level yourself. If
you need a number that is not in `facts`, say that it is missing.

| Field | Content | Source in the app today |
|---|---|---|
| `question`, `askedAt`, `direction` | User text, time, `long`, `short`, or null | Request |
| `reason` | The reason in the question, or null | Request (the server extracts it) |
| `asOf` | Time of the last bar per timeframe, and `partial: true` if the session is open | Bars |
| `quote` | Last price, day change, day change % | `/api/quotes` |
| `recentMove` | Change over the last 1, 3, and 5 sessions, with the start and end closes | Bars |
| `bars` | Last bar per timeframe: OHLCV, volume / 20-bar average volume | Bars |
| `volumeSignals` | Capitulation bar (yes/no, date), volume dry-up (yes/no) | **Missing** |
| `mas` | EMA20, EMA50, EMA200: value, slope sign, signed distance %, and `above` or `below` | `src/indicators/math.ts` |
| `momentum` | RSI14, MACD line, signal, histogram slope, last cross date, per timeframe | `src/indicators/math.ts` |
| `rating` | Per timeframe (4H, 1D, 1W, 1M): score −1 to +1, MA part, oscillator part, and the label | **Missing** |
| `atr` | ATR14 per timeframe, and as % of price | `src/indicators/math.ts` |
| `adx` | ADX14 per timeframe | **Missing** |
| `bands` | Bollinger upper and lower band, per timeframe | **Missing** |
| `swings` | Recent swing highs and lows, with dates, per timeframe | `src/indicators/pivots.ts` |
| `structure` | BOS and CHoCH events: side, level, date | **Missing** |
| `range` | Range high, range low, equilibrium, price position %, zone | **Missing** |
| `fib` | Higher-timeframe swing, retracement %, nearest fib levels with names | **Missing** |
| `fvg` | Open fair value gaps: side, top, bottom, `touched` | `src/indicators/fvg.ts` |
| `orderBlocks` | Side, top, bottom, `touched`, `priceInside` | **Missing** |
| `liquidity` | Zones and sweeps | `src/indicators/liquidity.ts` |
| `lastReport` | Date, EPS actual and estimate, revenue actual and estimate in millions, sessions ago | `/api/fundamentals/earnings` (no guidance, no quarter label) |
| `valuation` | P/E, D/E, net margin, ROE, FCF per share, and the same for 2–4 peers | `/api/fundamentals/overview` (peers **missing**) |
| `earnings` | Next report date | `/api/fundamentals/earnings` |
| `analysts` | Rating counts, target consensus, high, low, and % from price | `/api/fundamentals/overview` |
| `peers` | Day change % of sector peers | **Missing** (sector in profile, quotes in `/api/quotes`) |
| `news` | Recent headlines, with source, date, and summary | `/api/fundamentals/news` |
| `provider` | `synthetic`, `mock`, or a real provider | `/api/capabilities` |
| `confluence` | Rows with arrows, and the count (see "Confluence") | **Missing** |
| `plans` | Risk plans that the server calculated (see "Risk plans") | **Missing** |

## Procedure

Do the steps in this order.

1. **Check the data.** Put the result first, before the verdict.
   - If `asOf` for 1D is older than the last session before `askedAt`, write: "The last
     daily bar is from <date>. The question is from <date>."
   - If `asOf.partial` is true, say that the volume of the last bar is for part of a session.
   - List each missing or empty field that you need.
   - If `provider` is `synthetic` or `mock`, say that the prices are generated, not market prices.
2. **Give the verdict in two or three sentences.** Tell if the direction is with the trend.
   Tell if the price now is a good entry, with the at-market R:R. Give the main reason for
   each. If `direction` is null, give the verdict for the long and for the short.
3. **Test the user's reason, if `reason` is not null.** For "it breaks support" (or "resistance"):
   - A break is a **close** through the level. A wick through the level and a close back is
     a sweep, not a break.
   - Give the low (or high), the level, the close, and the volume ratio of the bar.
   - If the real break was on an earlier bar, give that date and level.

   If `reason` is null, describe `recentMove` in one sentence: size, sessions, and where
   it stopped.
4. **Give the context.** One line each:
   - Price against the three MAs, with distances and slopes. Give the MA order.
   - Structure: the CHoCH and BOS events, oldest first.
   - Range: range high, range low, equilibrium, price position %, and the zone.
   - Zones near price: FVGs and order blocks. Call a zone "untested" only when `touched` is
     false. If `priceInside` is true, say that price is inside the zone.
   - Fib: the higher-timeframe swing, the retracement %, and the levels on each side. Use
     the names in `fib`. The golden pocket is the 61.8%–65% retracement only.
   - ATR on the primary and the lower timeframe.
   - The last report, if it is 10 sessions old or newer. For each number, name what it is
     compared with: "EPS $2.29 against an estimate of $X" or "against $0.85 a year ago".
   - News: give the source and the date of each item. Use only numbers that are in the
     item. Do not add forecasts that the item does not contain.
   - **For a falling price** (or a rising price for a short), list the signals of a low (a
     high) and tell which are present: a MACD cross on 1D or 4H, a capitulation bar, a
     volume dry-up, a close back above (below) a broken level.
5. **Show the confluence table.** See "Confluence".
6. **Give the case for the trade and the case against it.** One short paragraph each. Name
   specific levels and readings, not general risk. Use `peers` here if it is present. Split
   the move into the sector part and the stock part only if `quote` and `peers` both exist.
7. **Give the risk plans.** See "Risk plans".
8. **Give the invalidation.** One sentence: the close that changes the read.

   If the verdict is "no trade now", also tell what must change for the trade to be valid.
   Give it as a plan with a trigger, an entry, a stop, and a target. Then name the warning
   levels on the way to the trigger, and say that they are not triggers.
9. **If the user can already be in the trade**, give one short paragraph: where to trail
   the stop, where to take a partial, and "do not add" if an exhaustion row is present.
10. **Give the next earnings date.** If it is inside the T2 time window, say that it is an
    event risk.
11. **Do not list chart marks.** The server draws them. See "Chart marks".
12. **End with the note:** "This is an analysis of chart data. It is not financial advice."

## Confluence

The server builds the rows and the count in `confluence`. Show the rows as a table. Use
the count from `confluence`. Do not count the arrows yourself.

Use one row for each signal. Each row has a reading and an arrow: ↓ bearish, ↑ bullish,
→ neutral. One signal gets one row. For example, all the daily MAs are in one row, so the
MAs get one vote.

Core rows. Use them when the data is present:

1. 1D rating (score and label, RSI, MACD line against signal, ADX)
2. 4H rating
3. 1W rating (momentum)
4. 1M rating, when there are enough monthly bars
5. Daily MAs (price against EMA20, EMA50, and EMA200, and their slopes)
6. Structure (BOS or CHoCH, new highs or lows)
7. Volume on the latest move
8. Exhaustion (RSI under 30 or over 70, price inside a zone against the trade, outside a band)

Optional rows. Use them when the data is present and is about this trade:

9. The bar of the user's reason (break or sweep)
10. Catalyst (last report, if it is 10 sessions old or newer)
11. Analyst consensus (rating counts and targets)
12. Trend strength (ADX under 20 on 1D means no daily trend)
13. Weekly structure (fib position, price against weekly MAs)
14. Extension (gain over 1 year, distance from EMA200). Put the distance from the high in
    the context, not in this row. A pullback from the high and an extension point in
    different directions.

Rating labels come from the score: under −0.5 Strong Sell, −0.5 to −0.1 Sell, −0.1 to +0.1
Neutral, +0.1 to +0.5 Buy, over +0.5 Strong Buy. Show the score next to the label:
"Sell (−0.34)".

If two rows for the same timeframe point in opposite directions (for example, 1W momentum ↓
and weekly structure ↑), say why: momentum and structure are different signals.

State the count: "N of M bearish" (or bullish). Then get the conviction:

- 85% or more of the rows with the trade: high conviction.
- 65% to 84%: moderate conviction.
- Under 65%: no bias. Say that the setup is not clear.

**Caps.** If the exhaustion row is against the trade, the conviction is moderate or lower.
Say: "capped by exhaustion". Exhaustion is an entry-timing veto, not a trend signal.

Then name the signals that decide the bias, and the signals that cap the conviction. Do
not give a number such as "55/45" unless `facts` contains it.

The confluence count is the only vote for the verdict. The rating rows are part of it. Do
not add a second vote, for example "2 of 4 timeframes agree". You can say how the
timeframes agree, but the verdict comes from the confluence count.

## Risk plans

The server calculates the plans. You choose which plans to show and you explain them. Do
not change the numbers.

Show these plans when `plans` has them:

- **At market.** Always show it. If the R:R to T1 is less than 1:1, write "not a trade at
  this price". Give the stop and the R:R.
- **Retest plan.** A limit entry at a broken level or a supply (demand) shelf, after a
  rejection on the lower timeframe.
- **Continuation plan.** A stop entry after a close through the next level.

For each plan, give the **entry type**: "limit sell at $X" or "sell stop after a close
under $X". Do not write only "use $X as the trigger".

Each plan has one trigger and one entry price. Two triggers at different prices make two
plans, each with its own R:R.

If `direction` is null, show the best plan for each direction.

Each plan has these fields, in this order:

`Entry` (type, price or range, and trigger) • `Invalidation` (level and reason) • `Stop`
(price, %, and the stop rule) • `T1` (price, %, R:R) • `T2` (price, %, R:R) • `T3` (only if
`plans` has it) • `Size` (risk as % of account) • `Management`.

A rejected plan also gives its stop and its R:R. Without the stop, the user cannot check the R:R.

**One invalidation level for each plan.** The stop comes from it. The exit rule uses it.
Do not call a different level "the invalidation line" in other parts of the answer. If a
level is the entry trigger, it is not the invalidation.

**Default management**, unless the user asks for a different rule:

1. Take half off at T1.
2. Move the stop to the entry when price reaches +1R.
3. Trail the rest behind the swing lows (highs) of the lower timeframe toward T2 and T3.

Do not tell the user to hold the full position to T2 or T3. In the backtest, that rule had
the lowest win rate and the deepest drop.

Rules for the server calculation:

- Stop = invalidation level ± 0.5 × ATR14 of the lower timeframe, on the far side of the
  level (above it for a short, below it for a long). Never put the stop at the level itself
  (user decision, 2026-10-31). For the 1D primary timeframe, use the 4H ATR, not the 1D ATR.
- Do not offer a tighter stop with a buffer under 0.33 × ATR(1D). In the backtest, these
  stops had no edge. If you mention a tighter stop, say why it is rejected.
- R:R uses the entry in the range that gives the **lower** R:R.
- Calculate R:R for T1, T2, and T3 with the same entry and the same stop.
- A percent distance is `(price − reference) / reference`. The reference is the entry for a
  plan, and the level or the MA for a distance. Use the same rule everywhere.
- Prefer the plan with the best R:R that is at or above 2:1. If no plan is at 2:1, say so.
- Size: 1% account risk. Use 0.5% when the plan is against the higher-timeframe trend, or
  when the next earnings date is 10 sessions away or less. Say the reason for 0.5%. A plan
  is against the higher-timeframe trend when the 1W rating is against it, or when price is
  on the other side of EMA200 (a long under EMA200, a short over it). In the backtest, trades
  against the 200-day trend had no edge.

## Chart marks

The server draws the marks on the chart: the entry, the stop, and the targets of every plan,
and the FVG and order block zones. You do not get the marks, and you do not make them.

- Do not write a `chart-marks` block or any other JSON.
- Do not write "I drew N levels". The chart shows them.

## Style

- Lead with the answer. Put the details after it.
- Use short sentences. Use numbers, not adjectives: "0.73× average volume", not "light volume".
- Use the user's terms back to them, and correct them when the chart says something else.
- Do not use more than one emoji.
- Do not write "usually", "often", or "textbook" about what price will do, unless `facts`
  has a statistic for it. Then give the statistic and its source.
- Use each zone with the one top and the one bottom that `facts` gives.
- Do not use two conviction words that disagree, for example "mixed, moderate conviction".

## Open decisions

None.

Closed. The samples did not agree on these items. The user decided, and a backtest checked
each decision (`docs/ai-samples/BACKTEST_REPORT.md`):

- **Long MA** (2026-10-31): EMA200, as in sample 002. Sample 001 uses SMA200. That is not
  the rule. Backtest: EMA200 and SMA200 agree on 94.6% of events. The trend filter is what
  matters: trades against the 200-day trend had no edge.
- **Stop rule** (2026-10-31): level ± 0.5 × ATR of the lower timeframe, as in sample 001.
  Sample 002 puts the stop at the level itself. That is not the rule. Backtest: a stop at
  the level had −0.115 R a trade. A buffer of 0.33 × ATR(1D) or more had +0.04 to +0.06 R.
- **Volume average** (2026-10-31): 20 bars. Samples 001–003 use 35, 30, and 25. Backtest:
  20 and 25 bars separate good breaks from bad breaks best.
- **Management** (2026-10-31): half at T1, stop to the entry at +1R, then trail. Sample 005
  takes one third at T1. Backtest: the same average R as one third, with the smallest drop.
