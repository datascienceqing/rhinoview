# Sample 002 — TER short, no reason given

- **Asked:** 2026-10-30
- **Symbol:** NASDAQ:TER
- **Chart:** 1D, with 4H and 1W for confirmation
- **Skill:** `trade-check` (`server/ai/skills/trade-check.md`)
- **Question:** "Can I short TER?"

The user gives no reason. Compare with sample 001, where the user said "it seems to break the support".

## Answer (reference, as supplied by the user)

<!-- Verbatim. Do not edit. The audit below records the problems. -->

> Note: news headlines weren't retrievable for this run — the catalyst below comes from the Q3 earnings release/8-K of 2026-10-28, and today's volume is a partial session.
>
> Short answer: the direction is right, the price is wrong. TER trend reads bearish on every timeframe, but a market short at $279.46 has an R:R of 0.73:1 — below even 1:1. You'd be selling into the third leg of a 13.5% three-day decline, sitting inside a daily demand zone, with RSI at 29.7 on both the 1D and 4H and not a single Sell rating across 20 analysts. That's a bad entry, not a bad thesis.
>
> **Confluence (7 of 9 bearish — moderate-credibility short, capped by the oversold inflection)**
>
> | Signal | Reading | → |
> |---|---|---|
> | 1D rating | Strong Sell — RSI 29.68, MACD −23.74 vs signal −16.76, ADX 26.9 | ↓ |
> | 4H rating | Strong Sell — RSI 29.61, MACD −18.84 vs −17.64, ADX 39.7 | ↓ |
> | 1W rating | Sell — RSI 40.49, MACD +2.00 vs signal +16.53 | ↓ |
> | Daily MAs | Price 17.1% below EMA20 $337.30, 22.1% below EMA50 $358.65, 15.8% below EMA200 $332.00 | ↓ |
> | Structure | Bearish CHoCH at $340.34 → BOS at $326.00; fresh 3-month low $275.31 today | ↓ |
> | Catalyst | Q3'26 (reported 2026-10-28): revenue $1,306M +70% YoY, EPS $2.29 vs $0.85 — but Q4 guide $1.95–2.25 implies sequential decline | ↓ |
> | Volume | Oct 28 5.11M = 1.83× 30-day avg (2.79M); Oct 29 4.23M = 1.52× — distribution, not panic-only | ↓ |
> | Exhaustion | RSI 29.7 on 1D and 4H; price inside daily bullish OB $263.02–296.44; below 4H lower band $284.18 | ↑ |
> | Analyst consensus | 12 Buy / 2 OW / 6 Hold / 0 Sell, avg PT $430.77 (+54.1%), low target $340 (+21.7%) | ↑ |
>
> Dominant driver for a swing horizon: the daily/4H distribution after a guide-down, with every daily MA overhead. The counterweight is exhaustion — not a trend signal, but an entry-timing veto.
>
> Bear case (what makes the short work) — Semi-capex is weak across the board today (AMAT −4.56%, LRCX −4.04%, MU −3.27%, NVDA −2.75%, KLAC −2.42%), so this is beta plus roughly 1–3pp of TER-specific guide disappointment. Weekly RSI at 40.5 has room to fall, price is in deep discount at 38.2% of the $151.52–487.91 range (equilibrium $319.72), and the $273.07 / $263.02 / $254.68 supports have not been tested on this leg. A break of $273.07 opens the $263 area quickly.
>
> Bull case / why shorting here specifically is dangerous — RSI ~29.7 on two frames inside a demand zone is textbook mean-reversion fuel, and the selloff is only two sessions old against a Q3 that beat the high end of guidance. Consensus sits 54% above spot with zero Sells. A reclaim of $296.82 (the broken 4H swing low) would trap late shorts and target $301.86, then $309.41 — which is exactly where the good short entry lives. That move would also flip the near-term read.
>
> What I'd actually do — wait for one of two triggers, and neither is "now":
>
> Preferred: rally-sell. Entry on a rejected retest at $309.41, stop $326.00 (bearish BOS level), T1 $263.02. Risk 5.4%, R:R 2.8:1. Size at 1% account risk.
> Only if you must be short today: use $296.82 as the trigger rather than market — but that R:R is under 1:1, so either widen the target to $254.68 or wait. A breakdown entry under $273.07 is worse: 0.78:1 to T1, 1.47:1 to T2 — not a trade.
>
> Risk Plan (preferred setup) — Entry ~$309.41 (trigger: rally into the $301.86–309.41 supply shelf and rejection / 4H close back below $309.41 after trading above it) • Invalidation $326.00 (structural: daily bearish BOS level) • Stop $326.00, −5.4% from entry (≈0.78× 1D ATR from entry — the level itself guarantees the buffer) • T1 $263.02 (R:R 2.8:1) • T2 $254.68 (R:R 4.3:1) • Size 1% account risk
>
> If you're already short from higher: trail the stop above $296.82, take a partial at $273.07, and let the rest ride behind the prior day's high. Don't add here — adding into exhaustion at RSI 30 is how a good short turns into a bad average.
>
> Next earnings: 2027-01-27, so no event risk in this window.
>
> Drew 8 levels on your NASDAQ:TER chart — BOS invalidation $326.00, short-entry shelf $309.41, resistances $301.86 / $296.82, and supports $273.07 / $263.02 / $254.68.

## Audit

I calculated each number again from the other numbers in the answer. I did not get the
TER bars, so I cannot verify the input values themselves.

### Correct

- Data date: the answer uses the Oct 28 and Oct 29 bars and says that today's volume is a
  partial session. The data agrees with the question date. Sample 001 did not do this.
- MA distances, with (MA − last) / MA: 17.15%, 22.08%, 15.83%.
- Volume ratios: 5.11 / 2.79 = 1.83. 4.23 / 2.79 = 1.52.
- Equilibrium: (151.52 + 487.91) / 2 = 319.72.
- Price targets: 430.77 / 279.46 = +54.1%. 340 / 279.46 = +21.7%.
- Preferred plan: risk 326.00 − 309.41 = 16.59 (5.36%). T1 reward 46.39, so R:R 2.8:1.
- Confluence count: 7 rows down, 2 rows up.

### Problems

1. **T2 R:R is wrong.** T2 reward is 309.41 − 254.68 = 54.73. 54.73 / 16.59 = **3.3:1**, not 4.3:1.
2. **The plans do not give a stop.** The at-market plan (0.73:1) and the breakdown plan
   (0.78:1 and 1.47:1) give no stop. For the at-market plan, a stop at 301.86 and T1 263.02
   give 0.73:1, so that is probably the stop. The answer must state it.
3. **The $296.82 plan is not clear.** $296.82 is above the price, so it is a resistance. A
   short there with a stop at $309.41 gives 2.7:1, not "under 1:1". The answer does not tell
   if it is a sell at $296.82 or a sell after a reclaim of $296.82.
4. **Eight levels, but the list has seven.** 326.00, 309.41, 301.86, 296.82, 273.07, 263.02, 254.68.
5. **Range position.** (279.46 − 151.52) / (487.91 − 151.52) = 38.0%, not 38.2%.
6. **The TER-specific part has no TER change.** "Beta plus roughly 1–3pp" needs the TER day
   change. The answer does not give it.
7. **EPS "vs $0.85" is not clear.** It can be the estimate or the EPS of a year ago. The
   answer also says "beat the high end of guidance", but it gives no guidance range for Q3.
8. **Unverifiable inputs.** The 13.5% three-day decline and "≈0.78× 1D ATR" need the prior
   closes and the ATR. The answer gives neither.

### Differences from sample 001

| Item | Sample 001 (CAT) | Sample 002 (TER) | Skill rule |
|---|---|---|---|
| Percent distance | Divides by the last price | Divides by the MA | Divide by the reference level |
| Long MA | SMA200 | EMA200 | **Open: user decides** |
| Stop | Level + 0.5 × ATR of 4H | The level itself | **Open: user decides** |
| Confluence rows | 8 fixed rows | 9 rows, with catalyst and analysts | Core rows, then optional rows |
| "Moderate" | 6 of 8 (75%) | 7 of 9 (78%), capped by exhaustion | Ratio, then caps |
| User reason | "Breaks the support" | None | Test the reason only if there is one |
| Extra sections | — | Peers, position management | Optional sections |

### Lessons for the skill

- If the user gives no reason, describe the latest move instead.
- Calculate T2 R:R in code, the same as T1.
- Give a stop for every R:R, also for a plan that you reject.
- Tell the entry type: a limit sell at a level, or a stop sell after a break.
- Make the list of chart marks from the JSON block, so the count is always correct.
- For a catalyst, tell what each number is compared with.
- Tell the user when the last bar is a partial session.
