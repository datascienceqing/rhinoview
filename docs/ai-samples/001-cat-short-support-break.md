# Sample 001 — CAT short into a support break

- **Asked:** 2026-10-24
- **Symbol:** NYSE:CAT
- **Chart:** 1D, with 4H and 1W for confirmation
- **Skill:** `trade-check` (`server/ai/skills/trade-check.md`)
- **Question:** "Can I short CAT? It seems to break the support."

## Answer (reference, as supplied by the user)

<!-- Verbatim. Do not edit. The audit below records the problems. -->

> Note: two data gaps to flag up front — the daily swing tool returned no setup object, so there is no tool-supplied entry/stop/target or R:R below (the plans are mine, built from the analyst's structure levels); and the news feed returned only 3 items, all routine corporate announcements, so no fundamental catalyst for today's drop could be verified.
>
> Short answer: the trend is bearish and a short is with the trend — but the break you're reacting to is not a break, and entering at market here is the worst-located trade in the whole setup.
> CAT last $733.24, −2.10% (−$15.74); the analyst's close $733.70 (0.06% drift, fine).
>
> **What actually happened vs. what you're seeing**
>
> Today is a wick-and-reclaim, not a breakdown. Today's low $704.01 > $702.99 (the daily bullish FVG floor) → the level held, and price closed $733.70, i.e. +4.22% off the low. Volume was 1.76M = 0.73× the 35-bar average — a low-volume reclaim, not capitulation.
> The real break already happened yesterday. Oct 14 close $748.98 < prior swing low $771.39 → confirmed bearish BOS. So a market short at $733 is −5.20% below the level that triggered the signal.
> Price sits below all three daily MAs: EMA20 799.52 (−9.0%), SMA200 804.96 (−9.8%), EMA50 819.17 (−11.7%) — all declining. Bearish stacking: EMA20 < SMA200 < EMA50.
> Structure: bearish CHoCH $845.55 (2026-08-27) → bearish BOS $771.39 (2026-10-14). Price is in the discount zone (equilibrium 805.27) with an untested bullish order block $662.85–708.63 directly beneath.
> ATR(14): 28.45 daily (3.9%), 20.32 on 4H. Next earnings 2026-11-04.
>
> **Confluence (6 of 8 bearish — moderate-conviction bearish bias, swing horizon)**
>
> | Signal | Reading | → |
> |---|---|---|
> | 1D rating | Sell (RSI 31.1, MACD −14.18 vs signal −5.11) | ↓ |
> | 4H rating | Sell (RSI 27.7, MACD −18.73 vs signal −9.29) | ↓ |
> | 1W rating | Sell (RSI 38.85, MACD +0.67 vs signal +20.67) | ↓ |
> | Daily MAs | price −9.0% EMA20 / −9.8% SMA200 / −11.7% EMA50, all falling | ↓ |
> | Breakdown volume | 1.50× and 1.40× average on Oct 13–14 | ↓ |
> | BOS | daily close $748.98 < swing low $771.39 (Oct 14) | ↓ |
> | Today's wick/reclaim | $704.01 low held FVG floor $702.99, closed $733.70 on 0.73× volume | ↑ |
> | RSI + ADX | RSI 31/28 near oversold; 1D ADX 16.41 = no daily trend | → |
>
> Dominant drivers for a swing question: the 3/3 bearish multi-timeframe alignment and the confirmed daily BOS. The wick/reclaim and sub-20 ADX are why conviction is capped.
>
> 📉 Case for the short — 3/3 timeframes bearish, price under every MA with MACD line below signal on all three, a confirmed daily BOS behind it, and the sell-off bars carried 1.4–1.5× average volume. Nothing has repaired that structure.
>
> Contrarian case / why not at market (the swing tool also labels the 1D trend bullish with a pullback of 123% — "very_deep/overextended", which directly contradicts the Sell rating — an inflection flag, so I'm deliberately holding conviction at roughly 55/45 rather than calling this a clean momentum short). The bounce risk is real: price is in discount, sitting just above a fresh, volume-confirmed demand zone, 4H RSI 27.7 is stretched, and 1D ADX 16.41 means the daily is not trending — below 20, oversold readings are mean-reversion fuel, not continuation confirmation.
>
> **Two ways to be short — and what not to do**
>
> At market now ($733.24): stop would have to sit above $771.39, giving R:R 0.72:1 to the first target. That's below 1:1 — not a trade, regardless of the bearish bias.
>
> Plan A — short the retest (preferred). Wait for price to rally back into the broken swing low $771.39, now supply, and fail there.
>
> Risk Plan A — Entry ~$768–771 (trigger: 4H rejection candle / close back under $765 after tagging $771.39) • Invalidation $771.39 (broken support reclaimed) • Stop $782 (−1.82%, = $771.39 + ~0.5×ATR4H) • T1 $702.99 (−8.5%, R:R 4.6:1) • T2 $662.85 (−13.7%, R:R 7.5:1) • Size 1% account risk; take ⅓–½ off at T1, trail the rest behind 4H structure
>
> Plan B — short the confirmed continuation. Wait for a daily close below $702.99 (which would confirm the wick was a prelude, not a reversal).
>
> Risk Plan B — Entry ~$700 (trigger: daily close < $702.99, enter on close or first retest) • Invalidation $719.74 (FVG top reclaimed) • Stop $722 (−3.14%) • T1 $662.85 (−5.3%, R:R 1.7:1 — marginal) • T2 $627.50 (−10.4%, R:R 3.3:1) • Size 1% account risk — only take this if T2 is the real objective
>
> What would change my mind entirely: a daily close back above $771.39 flips the read bullish — that is the line to respect, not the intraday noise.
>
> On your chart (NYSE:CAT, 1D) I marked: $819.17 EMA50, $804.96 SMA200 and $789.81 swing high as overhead supply; $771.39 as the amber broken-support/retest-short line; the demand band $719.74–$702.99 with $702.99 as the amber daily-close trigger; plus $662.85 and $627.50 as downside targets — and shaded the unfilled daily bullish FVG ($702.99–719.74) and the untested bullish order block ($662.85–708.63).

## Audit

I calculated each number again from the other numbers in the answer. I did not get the
CAT bars, so I cannot verify the input values themselves.

### Correct

- Change: 748.98 − 733.24 = 15.74. 15.74 / 748.98 = 2.10%.
- Close off the low: 733.70 / 704.01 = +4.22%.
- MA distances: (MA − last) / last gives 9.04%, 9.78%, 11.72%.
- ATR as a percent: 28.45 / 733.24 = 3.88%.
- Plan A stop: 771.39 + 0.5 × 20.32 = 781.55. The answer rounds it to 782.
- Plan A, from entry 768: risk 14.00, T1 reward 65.01 (4.6:1), T2 reward 105.15 (7.5:1).
- Plan B, from entry 700: risk 22.00 (3.14%), T1 1.7:1 (5.3%), T2 3.3:1 (10.4%).
- Confluence count: 6 rows down, 1 row up, 1 row neutral.

### Problems

1. **Stale data.** The question date is 2026-10-24. The prior close is 748.98, and that is the
   Oct 14 close. Thus "today" in the answer is 2026-10-15. The answer used data that was nine
   days old, or it is from a different day. The answer does not tell the user.
2. **Order block called "untested".** Today's low 704.01 is inside the order block
   662.85–708.63. Price touched the block on the same day.
3. **At-market R:R has no stop.** The answer gives 0.72:1 but no stop price. A stop at 771.39
   gives 0.79:1. A stop at 782 gives 0.62:1. The value 0.72 needs a stop at about 775.25.
4. **Distance convention.** "−5.20% below the level" divides by the last price (38.15 / 733.24).
   The usual convention divides by the level (−4.95%). The answer uses one convention but does
   not state it.
5. **Equilibrium has no range.** The answer gives 805.27 but not the range high and range low.
   The user cannot check it.
6. **Swing tool contradiction.** The answer says the swing tool "returned no setup object", but
   it also quotes the trend label of the same tool. The answer must tell which fields came back.

### Lessons for the skill

- Check the date of the last bar against the question date. Tell the user about any gap.
- Calculate each percent and each R:R in code, not in the model.
- Give the stop for every R:R.
- Do not call a zone "untested" if a bar in the window touched it.
- Give the range for equilibrium and premium/discount.
