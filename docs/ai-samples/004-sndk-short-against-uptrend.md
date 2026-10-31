# Sample 004 — SNDK short against an uptrend

- **Asked:** 2026-10-08
- **Symbol:** NASDAQ:SNDK
- **Chart:** 1D, with 4H, 1W, and 1M for confirmation
- **Skill:** `trade-check` (`server/ai/skills/trade-check.md`)
- **Question:** "Can I short SNDK here?"

The user asks for a short against an intact uptrend. Samples 001–003 were all in a
downtrend. This sample also adds a 1M timeframe and numeric rating scores.

## Answer (reference, as supplied by the user)

<!-- Verbatim. Do not edit. The audit below records the problems. -->

> Short answer: not here — a short at $1,660.46 has no structural trigger and fails the risk/reward floor. That said, the read is genuinely mixed rather than outright bullish, so here's the evidence both ways.
>
> I've marked the six relevant levels on your SNDK chart.
>
> **Confluence (5 of 8 bullish, 2 bearish, 1 neutral — leaning against the short, moderate conviction, swing horizon)**
>
> | Signal | Reading | → |
> |---|---|---|
> | 1D rating | Neutral (−0.09): MA Neutral, oscillators Sell | → |
> | 4H rating | Sell (−0.34): RSI 41.6, MACD −0.94 < signal 14.17 (hist −15.1), price on lower BB $1,656.5 | ↓ |
> | 1W rating | Buy (0.27): MA Strong Buy, oscillators Neutral | ↑ |
> | 1M rating | Buy (0.19): MA Strong Buy | ↑ |
> | 1D structure | Bullish & strong, 8 swings aligned, last event a bullish BOS at $777.60, no bearish CHoCH | ↑ |
> | Position in range | −61.4% pullback sitting on the fib 0.618 golden pocket $1,659.02 (demand) | ↑ |
> | Today's volume | 6.53M vs 7.24M 10-day avg → rel vol 0.83 on a −2.56% day (no distribution) | ↑ |
> | Extension | YTD +579.5%, 1Y +1,142.9%, ATH $2,354.39 −29.5% | ↓ |
>
> Counting 4 timeframes: 2 bullish (1W, 1M), 1 bearish (4H), 1 neutral (1D). Dominant frame for a swing question is the daily — and the daily is Neutral. With only 2 of 4 frames agreeing (<60%), the default verdict is neutral / wait, not short.
>
> **The case FOR shorting (this is the contradicting signal, and it's real)**
>
> The 4H is outright Sell: RSI 41.6, MACD line below signal with a −15.1 histogram, price pinned to the lower Bollinger Band. Short-term momentum is genuinely negative.
> 1D oscillators read Sell even though the MA stack is Neutral — momentum is deteriorating, not confirming.
> The stock is wildly extended on a longer view: +579.5% YTD, +1,142.9% over a year, and still −29.5% below its all-time high. This is the profile of a name where profit-taking can be violent.
> ADX 15.0 (1D) / 12.5 (4H) = no trend conviction on either working timeframe, so the "trend will carry me" argument cuts both ways.
>
> **The case AGAINST shorting here (why the answer is no)**
>
> Structure hasn't broken. 8 aligned bullish swings, the last structural event was a bullish BOS, and there is no bearish CHoCH. You'd be shorting into demand, against the prevailing structure — that's a counter-trend fade, not a short setup.
> $1,659.02 is the fib 0.618 golden pocket and price is effectively on it. The analyst graded the −61.4% pullback "healthy". This is the textbook long-pullback zone, not a distribution top.
> The selling has no conviction. Today's −2.56% came on 0.83× relative volume. Real tops distribute on expanding volume. This one isn't.
> Price is only 1.7% below the 1D EMA50 ($1,632.10) and 43.1% above the SMA200 ($1,160.60) — the moving-average structure is still stacked up.
> Positioning and catalysts are against you: consensus is Strong Buy (23 buy / 3 overweight / 5 hold / 1 underweight / 0 sell) with an average target of $2,275.85 (+37.1%), and Mizuho maintained Outperform today. Earnings land 2026-10-29 — floating a short into a high-beta, high-multiple name through that print is gap risk with no edge.
>
> **Risk Plan — the arithmetic is what actually kills this trade:**
>
> Short at market $1,660.46 • Correctly buffered invalidation is above fib 0.5 resistance $1,706.84 + 0.5×ATR(1D) = stop $1,754.53 • risk $94.07 (+5.66%, ≈0.99× ATR) • T1 $1,590.93 → R:R 0.74:1 • T2 $1,504.20 → R:R 1.66:1
> Both targets are below the 2:1 floor, and T1 is below 1:1. A tighter stop at $1,715 gives R:R 1.27 / 2.87 — but it sits only 2.8% above price, inside one routine up-day, so it would get swept before the thesis plays out.
>
> **What would have to change for the short to be valid (the only structure I'd take):**
>
> Trigger: a daily close below $1,504.20 (swing low / fib 1.0 → bearish CHoCH) on rising volume. Working entry ~$1,500 • stop $1,551.89 ($1,504.20 + 0.5×ATR) • target $1,160.60 (SMA200) → R:R 6.5:1 • size 1% account risk.
> Intermediate warnings to watch: loss of $1,590.93 (fib 0.786), then $1,632.10 (EMA50). Neither is a short trigger on its own — both are levels inside an intact uptrend.

## Audit

I calculated each number again from the other numbers in the answer. I did not get the
SNDK bars, so I cannot verify the input values themselves.

### Correct

- Fib levels agree with one swing, $1,504.20 to $1,909.48: 0.5 = 1,706.84, 0.618 = 1,659.02,
  0.786 = 1,590.93, 1.0 = 1,504.20. Price is at a 61.4% retracement.
- At-market plan: risk 1,754.53 − 1,660.46 = 94.07 (5.67%). T1 0.74:1. T2 1.66:1.
- Both stops give the same daily ATR: (1,754.53 − 1,706.84) × 2 = 95.38 and (1,551.89 − 1,504.20) × 2 = 95.38.
- Tight-stop plan: risk 54.54. T1 1.27:1. T2 2.87:1.
- Continuation plan: risk 51.89. Reward 339.40. R:R 6.5:1.
- SMA200 distance: (1,660.46 − 1,160.60) / 1,160.60 = +43.1%.
- Below the ATH: 1,660.46 / 2,354.39 − 1 = −29.5%. Average target: +37.1%.
- 4H histogram: −0.94 − 14.17 = −15.11.
- Ratings agree with the usual score bands: −0.09 Neutral, −0.34 Sell, +0.27 Buy, +0.19 Buy.
- Confluence count: 5 rows up, 2 rows down, 1 row neutral.

### Problems

1. **"Below" is wrong.** Price $1,660.46 is 1.7% **above** the EMA50 ($1,632.10), not below it.
2. **The relative volume is wrong.** 6.53 / 7.24 = **0.90**, not 0.83. The answer also uses a
   10-day average. The skill uses 20 bars.
3. **The tight stop distance is wrong.** (1,715 − 1,660.46) / 1,660.46 = **3.3%**, not 2.8%.
4. **The stop uses the daily ATR.** The skill rule is 0.5 × ATR of the lower timeframe (4H).
   The backtest shows a similar result for 0.33 to 1.0 × daily ATR, so the plan is not bad.
   But the answer does not follow the rule.
5. **SMA200 again.** The skill uses EMA200.
6. **"Six levels", but there is no list.** The answer names more than six prices in the text.
   The user cannot tell which six are on the chart.
7. **Two vote systems.** The answer gives a confluence count (5 of 8) and a timeframe count
   (2 of 4). It does not tell which one decides the verdict.
8. **The extension row mixes two ideas.** "+579.5% YTD" is extension. "−29.5% below the ATH"
   is a pullback. They point in different directions.
9. **News with no source.** "Mizuho maintained Outperform today" has no source or link.
10. **No data check, no note.** The answer does not start with the data check, and it does
    not end with the note that it is not financial advice.

### Differences from samples 001–003

| Item | 001–003 | 004 (SNDK) |
|---|---|---|
| Trend | Down | **Up**: the short is against the trend |
| Timeframes | 1D, 4H, 1W | 1D, 4H, 1W, **1M** |
| Ratings | Words only | **Score −1 to +1**, with words |
| Timeframe vote | Not used | "Under 60% of timeframes agree → wait" |
| Stop ATR | 4H | **1D** |
| Volume average | 35, 30, 25 bars | 10 days |
| Tight stop | Not shown | Shown and rejected: inside one normal day |

### Lessons for the skill

- The server gives each distance with its sign and the word "above" or "below".
- Use the rating score and the standard bands. Show the score next to the word.
- Use one vote system for the verdict. The timeframe vote is one input to it.
- Do not offer a stop with a buffer under 0.33 × daily ATR. The backtest shows no edge there.
- Put the extension and the pullback from the high in separate rows, or leave them out.
- When there is no trigger now, give the trigger that makes the trade valid, as a plan.
