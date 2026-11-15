---
name: trade-check
description: Answer "can I long/short X?" or "is this a good entry?" with a verdict, the structure, a confluence table, and risk plans.
version: 0.8.0
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

The user message is one JSON object with `question` and `facts`. The server calculates every
number in `facts`. Use only the numbers in `facts`. Do not calculate a new percent, ratio, or
level yourself. If you need a number that is not in `facts`, say that it is missing.

`<tf>` is a timeframe key: `4h`, `1D`, `1W`, or `1M`. A timeframe can be absent.

| Field | Content |
|---|---|
| `askedAt`, `symbol` | The time of the question (ISO, UTC), and the symbol |
| `direction` | `long`, `short`, or null when the question gives no direction |
| `reason` | The reason in the question, or null |
| `provider`, `synthetic` | The data provider. `synthetic: true` means generated prices |
| `dataCheck` | `lastDailyBar` (date), `staleDays`, `stale`, `partialSession`, and `missing` (a list of the parts that the server could not get) |
| `quote` | `last`, `change`, `changePct` for the day. Can be null |
| `recentMove` | A list for 1, 3, and 5 sessions: `fromClose`, `toClose`, `pct` |
| `timeframes.<tf>.lastBar` | `date`, `open`, `high`, `low`, `close`, `volume`, and `volumeRatio` (volume / 20-bar average) |
| `timeframes.<tf>.rsi` | RSI14 |
| `timeframes.<tf>.macd` | `line`, `signal`, `histogram`, `histogramTrend` (`widening` or `narrowing`), `lastCross` (`date`, `side`) |
| `timeframes.<tf>.atr`, `.atrPct` | ATR14, and ATR14 as % of the close |
| `timeframes.<tf>.adx` | `adx`, `plusDi`, `minusDi` (14) |
| `timeframes.<tf>.bands` | Bollinger `upper`, `lower`, and `position` (`above upper`, `below lower`, `inside`) |
| `timeframes.<tf>.rating` | `score` (−1 to +1), `maScore`, `oscillatorScore`, and `label` |
| `mas` | Daily EMA20, EMA50, EMA200: `value`, `slope`, `distancePct` (price from the MA), `position` (`above` or `below`) |
| `maOrder` | The three MAs from the highest to the lowest, or null |
| `structure`, `structure4h` | Daily and 4H: `trend`, and `events` (oldest first): `kind` (`BOS` or `CHoCH`), `side`, `level`, `date` |
| `swings` | Recent daily swing highs and lows: `kind`, `date`, `price` |
| `range` | Daily dealing range: `high`, `low`, `equilibrium`, `positionPct` (0 at the low, 100 at the high), `zone` (`premium`, `discount`, `equilibrium`) |
| `fib` | The last weekly leg: `direction`, `from`, `to`, `retracementPct`, `goldenPocket`, `levels` (`name`, `price`), and the nearest level `above` and `below` |
| `fvg` | Open daily fair value gaps, nearest first: `side`, `top`, `bottom`, `date`, `touched`, `priceInside` |
| `orderBlocks` | Daily order blocks: `side`, `top`, `bottom`, `date`, `touched`, `priceInside` |
| `volumeSignals` | `capitulation` (`date`, `ratio`) or null, `dryUp` (true or false), `recentRatio` |
| `lastReport` | `date`, `epsActual`, `epsEstimate`, `revenueActualMillions`, `revenueEstimateMillions`, `sessionsAgo`. Can be null |
| `earnings` | `next` (the date of the next report) and `sessionsAway`. Each can be null |
| `analysts` | Rating counts (`strongBuy`, `buy`, `hold`, `sell`, `strongSell`), `consensus`, the targets (`targetConsensus`, `targetMedian`, `targetHigh`, `targetLow`), and `consensusPct`, `highPct`, `lowPct` (target from price). Can be null |
| `news` | Up to 5 items, newest first: `date`, `title`, `publisher`, `summary` |
| `confluence` | The rows, the counts, and the conviction (see "Confluence") |
| `plans` | The risk plans (see "Risk plans"). Can be empty |

`facts` has no sector peers, no valuation ratios, and no liquidity zones. Do not use them, and
do not report them as missing.

## Procedure

Do the steps in this order.

1. **Check the data.** Put the result first, before the verdict. Write a sentence only for
   an item that applies. If none applies, write no data check.
   - If `dataCheck.stale` is true, write: "The last daily bar is from <`dataCheck.lastDailyBar`>.
     The question is from <the date of `askedAt`>."
   - If `dataCheck.partialSession` is true, say that the volume of the last bar is for part
     of a session.
   - If `dataCheck.missing` is not empty, list its entries. Do not list other fields.
   - If `synthetic` is true, say that the prices are generated, not market prices.
2. **Give the verdict in two or three sentences.** Tell if the direction is with the trend.
   Tell if the price now is a good entry, with the R:R to T1 of the at-market plan. Give the
   main reason for each. If `direction` is null, give the verdict for the long and for the short.
3. **Test the user's reason, if `reason` is not null.** For "it breaks support" (or "resistance"):
   - A break is a **close** through the level. A wick through the level and a close back is
     a sweep, not a break.
   - Give the low (or high), the level, the close, and the volume ratio of the bar.
   - If the real break was on an earlier bar, give that date and level from `structure.events`.

   If `reason` is null, describe `recentMove` in one sentence: size, sessions, and where
   it stopped.
4. **Give the context.** One line each. Leave a line out when its data is null or empty.
   - Price against the three MAs, with distances and slopes. Give `maOrder`.
   - Structure: the CHoCH and BOS events of `structure`, oldest first.
   - Range: range high, range low, equilibrium, price position %, and the zone.
   - Zones near price: FVGs and order blocks. Call a zone "untested" only when `touched` is
     false. If `priceInside` is true, say that price is inside the zone.
   - Fib: the weekly leg, the retracement %, and the levels `above` and `below`. Use the
     names in `fib`. Say "golden pocket" only when `fib.goldenPocket` is true.
   - ATR on `1D` and on `4h`.
   - The last report, if `lastReport.sessionsAgo` is 10 or less. For each number, name what
     it is compared with: "EPS $2.29 against an estimate of $X".
   - News: give the publisher and the date of each item. Use only numbers that are in the
     item. Do not add forecasts that the item does not contain.
   - **For a falling price** (or a rising price for a short), list the signals of a low (a
     high) and tell which are present: a MACD cross on `1D` or `4h` (`macd.lastCross`), a
     capitulation bar, a volume dry-up, a close back above (below) a broken level.
5. **Show the confluence table.** See "Confluence".
6. **Give the case for the trade and the case against it.** One short paragraph each. Name
   specific levels and readings, not general risk.
7. **Give the risk plans.** See "Risk plans".
8. **Give the invalidation.** One sentence: the close that changes the read.

   If the verdict is "no trade now", also tell what must change for the trade to be valid.
   Use a retest or a continuation plan from `plans` for this. Then name the warning levels
   on the way to the trigger, and say that they are not triggers.
9. **If the user can already be in the trade**, give one short paragraph: where to trail
   the stop, where to take a partial, and "do not add" if `confluence.cappedByExhaustion` is true.
10. **Give the next earnings date** (`earnings.next`). If `earnings.sessionsAway` is 10 or
    less, say that it is an event risk.
11. **Do not list chart marks.** The server draws them. See "Chart marks".
12. **End with the note:** "This is an analysis of chart data. It is not financial advice."

## Confluence

The server builds the rows, the counts, and the conviction in `confluence`. Do not count
the arrows yourself, and do not calculate the conviction yourself.

- Show every row of `confluence.rows` as a table, in the given order: the signal, the
  reading, and the arrow. Do not add a row. Do not remove a row.
- Arrows: `up` is ↑ bullish, `down` is ↓ bearish, `neutral` is →.
- One signal has one row. For example, all the daily MAs are in one row, so the MAs get one vote.
- `confluence.side` is the side that the count is for. State the count from
  `confluence.bullish` or `confluence.bearish`: "N of M bearish" (or bullish). M is the
  number of rows in the table.
- State the conviction from `confluence.conviction`: `high`, `moderate`, or `none`. For
  `none`, say that there is no bias and that the setup is not clear.
- If `confluence.cappedByExhaustion` is true, say: "capped by exhaustion". Exhaustion is an
  entry-timing veto, not a trend signal.

If two rows for the same timeframe point in opposite directions (for example, 1W rating ↓
and weekly structure ↑), say why: momentum and structure are different signals.

Then name the signals that decide the bias, and the signals that cap the conviction. Do
not give a number such as "55/45" unless `facts` contains it.

The confluence count is the only vote for the verdict. The rating rows are part of it. Do
not add a second vote, for example "2 of 4 timeframes agree". You can say how the
timeframes agree, but the verdict comes from the confluence count.

## Risk plans

The server calculates the plans. You choose which plans to show and you explain them. Do
not change the numbers. If `plans` is empty, say that the server found no plan with a stop
and a target. Do not make a plan yourself.

Each plan in `plans` has these fields:

| Field | Content |
|---|---|
| `kind`, `side` | `market`, `retest`, or `continuation`; `long` or `short` |
| `entryType` | `market`, `limit`, or `stop` |
| `entryLow`, `entryHigh` | The entry range. The two are equal for one price |
| `rrEntry` | The entry that the R:R uses: the price in the range that gives the lower R:R |
| `trigger` | The entry condition, as text |
| `invalidation` | `price` and `label`: the one invalidation level of the plan |
| `stop`, `stopPct` | The stop price, and its distance from `rrEntry` in % |
| `stopRule` | `invalidation`, `atrMult`, `atrLower`: the stop is the invalidation level plus or minus `atrMult` × the 4H ATR, on the far side of the level |
| `targets` | T1, T2, T3 in order: `price`, `label`, `pct` (from `rrEntry`), `rr`. `projected: true` marks a range extension: a projection past the range, not a level that price tested |
| `sizePct`, `sizeReason` | Account risk in %: 1, or 0.5 with the reason |
| `meetsTwoToOne` | The R:R to T2 is 2:1 or more (to T1 when the plan has one target) |

Show these plans when `plans` has them:

- **At market** (`kind: market`). Always show it. If the R:R to T1 is less than 1, write
  "not a trade at this price". Give the stop and the R:R.
- **Retest plan.** A limit entry at a broken level, after a rejection on the lower timeframe.
- **Continuation plan.** A stop entry after a close through the next level.

For each plan, give the **entry type**: "limit sell at $X" or "sell stop after a close
under $X". Do not write only "use $X as the trigger".

If `direction` is null, show the best plan for each direction. Prefer the plan with the
best R:R among the plans where `meetsTwoToOne` is true. Between two such plans, prefer the
plan whose T1 is not a projection. If no plan has it, say so.

Give each plan in this order:

`Entry` (type, price or range, and trigger) • `Invalidation` (level and reason) • `Stop`
(price, %, and the stop rule) • `T1` (price, %, R:R) • `T2` (price, %, R:R) • `T3` (only if
the plan has it) • `Size` (`sizePct`, and `sizeReason` when it is not null) • `Management`.

When a target has `projected: true`, say that it is a projection. Price is at a new high (or
low), so no tested level is there.

A rejected plan also gives its stop and its R:R. Without the stop, the user cannot check the R:R.

**One invalidation level for each plan.** The stop comes from it. The exit rule uses it.
Do not call a different level "the invalidation line" in other parts of the answer. If a
level is the entry trigger, it is not the invalidation.

**Default management**, unless the user asks for a different rule:

1. Take half off at T1.
2. Move the stop to the entry when price reaches +1R.
3. Trail the rest behind the swing lows (highs) of the lower timeframe toward T2 and T3.

Do not tell the user to hold the full position to T2 or T3.

Do not offer a tighter stop than the stop of the plan. If the user asks for one, say that
the stop rule keeps a buffer past the level, and that a stop at the level itself is not the rule.

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

<!-- developer-notes -->

# Developer notes

The model does not get this part. `parseSkill` (`server/ai/skills.ts`) removes everything
from the `developer-notes` marker to the end of the file. Keep the "Input" section above
equal to the `Facts` type in `server/ai/facts/build.ts`.

## Server calculation of the plans

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
  `meetsTwoToOne` uses T2 (T1 when the plan has one target), not T3 (user decision, 2026-11-14).
- Targets are the levels ahead of the entry, with the range high and the range low. Past
  the last level, the server adds the range extensions 1.272 and 1.618 (range height from
  the range high for a long, from the range low for a short). They are targets only. There
  is no backtest of the extension targets.
- Size: 1% account risk. Use 0.5% when the plan is against the higher-timeframe trend, or
  when the next earnings date is 10 sessions away or less. Say the reason for 0.5%. A plan
  is against the higher-timeframe trend when the 1W rating is against it, or when price is
  on the other side of EMA200 (a long under EMA200, a short over it). In the backtest, trades
  against the 200-day trend had no edge.

## Confluence rows

The server builds the rows in `server/ai/facts/build.ts`. This was the specification. The
server does not build rows 9, 13, and 14 yet.

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

Conviction: 85% or more of the rows with the trade is high. 65% to 84% is moderate. Under
65% is no bias. An exhaustion row against the trade caps the conviction at moderate.

## Decisions

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
