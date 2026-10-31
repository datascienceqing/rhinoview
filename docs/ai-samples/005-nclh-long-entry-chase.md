# Sample 005 — NCLH long entry after a strong day

- **Asked:** 2026-10-06
- **Symbol:** NYSE:NCLH
- **Chart:** 1D, with 4H and 1W for confirmation
- **Skill:** `trade-check` (`server/ai/skills/trade-check.md`)
- **Question:** "Is it a good entry point for NCLH"

This is the first long sample. The user gives no direction, but the answer reads the
question as a long after a +4.4% day. The answer also uses fundamentals and peers, and it
has a third target and trade management rules.

## Answer (reference, as supplied by the user)

<!-- Verbatim. Do not edit. The audit below records the problems. -->

> Short answer: not at $15.52. NCLH is up +4.4% today ($15.52, day range 15.05–15.61), which has pushed it above the upper Bollinger Band on both the 1D and 4H — you'd be chasing into an extended bar inside a still-bearish weekly trend. The tradeable version of this idea is a pullback entry at $15.03, which I've marked on your chart.
>
> Counting 3 timeframes: 2 bullish (1D, 4H), 1 bearish (1W), 0 neutral. Dominant frame for a swing question: 1D. Verdict: genuinely mixed — no clean edge at the current price.
>
> **Confluence (3 of 6 directional rows bullish — mixed, moderate conviction, swing horizon)**
>
> | Signal | Reading | → |
> |---|---|---|
> | 4H rating | Buy — RSI 64.2, MACD line +0.09 vs signal −0.03 (bullish cross) | ↑ |
> | 1D rating | Buy — RSI 53.5 | ↑ |
> | 1W rating | Sell — RSI 39.5, moving averages Strong Sell | ↓ |
> | 4H structure | Bullish CHoCH at $15.03 — the reversal signal off the low | ↑ |
> | 1D SMC | Bearish — BOS down at $18.31; price 38% below the $25.125 swing high | ↓ |
> | Extension | Above upper Bollinger on 1D and 4H — poor chase entry | ↓ |
>
> The two rows that carry the most weight for a swing entry: the 4H bullish CHoCH at $15.03 (that's your invalidation line and your entry trigger) against the 1W Sell / 1D bearish structure (that's the ceiling). Everything between $15.52 and $17.04 is a 4H bearish order block that caps the reward leg.
>
> **Bull case**
>
> 4H printed a bullish change of character at $15.03 with a MACD cross confirmed — the first real reversal signal off the low, and the pullback that followed is overextended (132.5%), which usually resolves upward.
> Valuation is the cheapest in the group: P/E 9.81 vs RCL 17.62 and CCL 11.59, on TTM revenue $10.15B (+6.2% y/y), net margin 7.5%, ROE 36.7%.
> Positive tape: Q3 2026 beat/guidance in the weekly recap (Oct 5) and Citigroup maintained at Buy (Oct 2).
>
> **Bear case**
>
> The weekly is broken. 1W Sell with MAs on Strong Sell and RSI 39.5 — a 4H reversal inside a weekly downtrend is a counter-trend bounce until proven otherwise.
> Leverage is the structural risk: debt $15.5B, D/E 6.21×, FCF −$1.19B — and the company just upsized a 2031 senior note offering, i.e. adding to the pile. That's why it trades at a discount to RCL.
> Weaker international tourism flows into the U.S. are a live headwind for the whole cruise group (Oct 5).
> Earnings 2026-11-04 (~4 weeks) — a binary in the middle of any swing you start now.
>
> **Why the current price fails the risk test**
>
> Entering at $15.52 with the structural stop at $14.53 gives R:R 0.31:1 to T1 ($15.83) and only 0.97:1 to T2 ($16.48) — below 1:1. That's not a trade, it's a chase.
>
> **Risk Plan (preferred setup — pullback entry)**
>
> Entry ~$15.03 (trigger: 4H close back above $15.03 after a pullback, on rising 4H volume) • Invalidation $14.53 (structural: 1D swing low, = Fib 0.786 at $14.73 minus a 0.5×ATR(4H) sweep buffer) • Stop $14.53 (−3.3%, 0.83×ATR 1D / 1.25×ATR 4H) • T1 $15.83 (R:R 1.6:1) • T2 $16.48 — Fib 1.618 (R:R 2.9:1) • T3 $17.04 — 4H bearish OB (R:R 4.0:1) • Size 1% account risk — the stop is tight in ATR terms, so size off the $0.50 stop distance, not off the price.
>
> Management: take a third off at T1, move the stop to entry once price clears $15.53 (+1R), then trail behind 4H higher lows toward T2/T3. Exit on a 4H close below $14.73 — that invalidates the CHoCH and re-opens $14.53 → $13.63 (52-week low).
>
> If it never pulls back: a 4H close above $15.83 is continuation, but the reward to the $17.04–$17.71 order block gives roughly 0.8:1 against a structural stop — so treat it as a trail-only trade with a partial at $16.48, not a fixed-target setup. Don't force it.
>
> Drew 9 levels on your NYSE:NCLH 1D chart: entry $15.03, stop $14.53, targets $15.83 / $16.48 / $17.04, plus context lines at Fib 0.786 ($14.73), the 4H FVG ($16.09), SMA50 ($16.60) and the 52-week low ($13.63). The 4H order-block zones aren't boxed because I didn't get their bar coordinates back — say the word and I'll pull them and draw the rectangles.

## Audit

I calculated each number again from the other numbers in the answer. I did not get the
NCLH bars or the financial statements, so I cannot verify the input values themselves.

### Correct

- At-market plan: risk 15.52 − 14.53 = 0.99. T1 reward 0.31 (0.31:1). T2 reward 0.96 (0.97:1).
- Preferred plan: risk 15.03 − 14.53 = 0.50 (3.3%). T1 1.6:1, T2 2.9:1, T3 4.0:1.
- Stop at +1R: 15.03 + 0.50 = 15.53.
- ATR values agree: 4H ATR = (14.73 − 14.53) × 2 = 0.40, and 0.50 / 0.40 = 1.25. 1D ATR = 0.50 / 0.83 = 0.60.
- Distance from the swing high: 15.52 / 25.125 − 1 = −38.2%.
- Chart marks: the answer says 9 levels and lists 9 levels. Samples 002 and 004 failed this check.
- Confluence count: 3 rows up, 3 rows down.

### Problems

1. **"Q3 2026 beat" cannot be correct.** Q3 ends on 2026-09-30, and the next report is on
   2026-11-04. That report is the Q3 report. The "beat" is probably from Q2.
2. **Three invalidation levels.** The text calls $15.03 "your invalidation line". The plan
   gives $14.53. The management rule exits on a 4H close below $14.73. A plan must have one.
3. **$14.53 has two meanings.** The plan calls it "1D swing low" and also "Fib 0.786 minus
   0.5 × ATR(4H)". If $14.53 is the swing low, the stop is at the level itself, and the stop
   rule says no. If the level is $14.73, the stop is correct.
4. **The order block has three ranges.** "$15.52–$17.04", "$17.04 — 4H bearish OB", and
   "$17.04–$17.71". They do not agree.
5. **The continuation R:R has no stop.** "Roughly 0.8:1" from $15.83: a stop at $14.53 gives
   0.93:1 to $17.04. A stop at $14.73 gives 1.10:1. Neither gives 0.8:1.
6. **"Mixed, moderate conviction."** 3 of 6 is 50%. Under the skill rule, that is "no bias".
   "Mixed" and "moderate conviction" do not agree.
7. **Size against the weekly trend.** The long is against the 1W trend, but the size is 1%.
   The skill uses 0.5% for a trade against the higher-timeframe trend. The backtest showed
   no edge for trades against the 200-day trend.
8. **A claim with no data.** "Overextended (132.5%), which usually resolves upward" gives no
   source and no statistics.
9. **ROE does not agree with D/E.** Debt $15.5B / D/E 6.21 = equity $2.50B. Net income is
   7.5% × $10.15B = $0.76B. ROE is then 30%, not 36.7%. An average-equity ROE can be
   different, but the answer does not say which ROE it uses.
10. **SMA50 in the marks.** The skill uses EMA20, EMA50, and EMA200.

### New items in this sample

| Item | What the answer did | Skill rule |
|---|---|---|
| Long side | Same structure as the shorts | The rules apply to both sides |
| Chase check | Close above the upper band on 1D and 4H | Part of the exhaustion row |
| Fundamentals | P/E against peers, leverage, FCF | Optional context, from `/api/fundamentals/overview` |
| Third target | T3 at the order block | Allowed, with the same entry and stop |
| Management | ⅓ at T1, stop to entry at +1R, trail 4H higher lows | Default exit rule |
| Missing zone data | The answer could not box the order blocks | The server sends zones with prices |

### Lessons for the skill

- One plan has one invalidation level. The trigger, the stop, and the exit rule use it.
- The server labels the quarter of each report. Do not name a quarter that has not been reported.
- The server gives each zone one top and one bottom. Do not give a zone other bounds.
- Do not say "usually" or "often" unless `facts` has a statistic for it.
- Use the default trade management rule unless the user asks for a different one.
