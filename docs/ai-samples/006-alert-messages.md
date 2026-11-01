# Sample 006 — five alert messages (CAT, ACMR, U, ARM, PEP)

- **Supplied:** 2026-10-31, as five screenshots of TradingView alerts
- **Skill:** `alert-explain` (`server/ai/skills/alert-explain.md`)
- **What the user wants:** the explanation of a fired alert answers four questions:
  1. Is the alert long or short?
  2. Why?
  3. Is it a trigger now, or must you wait for a pattern or a close?
  4. What is the stop?

These samples are alert messages, not explanations. The explanation must look "sort of
like these". Each message gives the side, the structure reason, the trigger kind, and the stop.

## Messages (reference, as supplied by the user)

<!-- Transcribed from the screenshots. Do not edit. The audit below records the problems. -->

### A. CAT 771.39 — short retest trigger (BOS level)

- Condition: CAT Crossing Up 771.39. Active. Created Thu 15 Oct '26 08:58:23.

> "CAT crossed UP $771.39 — the 14-Oct bearish BOS level (prior swing low, broken on a $748.98 close) and now the nearest supply. Plan A SHORT trigger: this alert is the TAG, not the entry. Wait for a 4H rejection candle or a close back below $765 before acting. Stop $782 (0.5x ATR4H above the level) | T1 $702.99 (R:R 4.6:1) | T2 $662.85 | Invalidation: a DAILY CLOSE above $771.39 reclaims broken structure and flips the read bullish — do not short into that."

### B. ACMR 62.78 — bearish-read flip level

- Condition: ACMR Crossing Up 62.78. Active. Created Thu 15 Oct '26 11:57:22.

> "ACMR crossed UP $62.78 — the prior swing low broken as a bearish BOS on 14 Oct, now the nearest real supply and the THESIS FLIP. A DAILY CLOSE above this reclaims broken structure and takes the bearish read to neutral-to-constructive. Above it the bear case is void: next references 69.81 (fib 0.236), then 78.42–82.63 (1D bearish FVG). Note this is the invalidation of the short side, not a long entry on its own — it sits inside the 57.32–61.12 no-man's-land if tagged from below."

### C. U 38.44 — short trigger (sell the pop)

- Condition: U Crossing Up 38.44. Active. Created Fri 30 Oct '26 19:05:39.

> "U rallied into 38.44 — the bearish CHoCH level / fib 1.0 and the SHORT TRIGGER. Wait for rejection or a 4H close back below it, not this intraday poke. Stop 40.44 (invalidation). T1 33.05 (R:R 2.70:1), T2 30.65 (R:R 3.90:1). Earnings 2026-11-05 — do not carry into the print at full size."

### D. ARM — pullback into $299–302 entry zone

- Condition: ARM Crossing 302.00. Active. Created Wed 23 Sep '26 14:14:04. Last triggered Wed 07 Oct '26 06:30:03.

> "ARM pulled back into the $299–302 entry zone. Wait for a 4H close back above $302.38 to trigger the long. Stop $289.29 | T1 $336.98 | T2 $359.63 | Invalidation: daily close below $298.38."

### E. PEP 123.85 — 52W low breakdown

- Condition: PEP Crossing Down 123.85. Active. Created Wed 07 Oct '26 09:18:33. Last triggered Wed 07 Oct '26 12:46:55.

> "PEP crossed DOWN $123.85 — the 52-week / 3-month low and the only structural support under price. This is the BEARISH resolution of the Oct 8 earnings print. Not a long entry: there is no structural level below here. Short-trigger variant needs a 4H close below with expanding volume; stop $126.60 (above the Oct 7 high + buffer), manage as a trailing trade with no fixed target. Do NOT buy the break — first meaningful reference to reclaim is the 130.22–132.93 daily bearish FVG."

## The four answers in each message

| Alert | Side | Why (structure) | Trigger kind | Stop |
|---|---|---|---|---|
| A. CAT | Short | Retest of the 14-Oct bearish BOS level, now supply | Tag. Wait for a 4H rejection or a close below 765 | 782 = level + 0.5 × ATR(4H) |
| B. ACMR | No trade. Flip level of the short | Prior swing low, broken as a BOS | Daily close above the level | None. It is an invalidation |
| C. U | Short | Bearish CHoCH level and fib 1.0 | Tag. Wait for a rejection or a 4H close below | 40.44 (invalidation) |
| D. ARM | Long | Pullback into the entry zone | Wait for a 4H close above 302.38 | 289.29 |
| E. PEP | Short (a variant) | Break of the 52-week low | Break. Needs a 4H close below and more volume | 126.60 = Oct 7 high + buffer |

The samples use three trigger kinds:

- **Tag:** the alert tells you that price is at the level. It is not the entry. The entry
  needs a 4H confirmation. Samples A, C, and D.
- **Close:** only a daily close past the level counts. Sample B, and every invalidation.
- **Break:** a 4H close past the level, with more volume than usual. Sample E.

Our alerts fire on an intraday cross. Thus the explanation must say which kind the alert
is, and then tell if the confirmation is present at the time of the explanation.

## Audit

### Correct items

- Each message gives the side, or says clearly that it is not a trade (B, and E for longs).
- Each message names the structure behind the level: BOS, CHoCH, fib, FVG, 52-week low.
- Each message tells you not to act on the cross alone. The confirmation is a 4H candle or a daily close.
- The invalidation is a daily close, not a wick. This agrees with `trade-check`.
- The stop in A uses the level + 0.5 × ATR of the lower timeframe. This is our stop rule.
- C gives the earnings date and reduces the size. Earnings are 4 sessions after the alert. Our rule (10 sessions or less) gives a 0.5% size.
- C has correct R:R from 38.44: (38.44 − 33.05) / (40.44 − 38.44) = 2.70, and 7.79 / 2.00 = 3.90.

### Problems

1. **A: the R:R basis is not clear.** From 771.39 the R:R to T1 is 68.40 / 10.61 = 6.4. From
   the confirmation close at 765 it is 62.01 / 17.00 = 3.6. The message says 4.6. That
   needs an entry near 768. Our rule uses the worse entry, here 765: R:R 3.6.
2. **C: the R:R uses the alert level, not the entry.** The entry waits for a 4H close below
   38.44. A lower entry gives a lower R:R. The worse entry must set the R:R.
3. **B: the zone does not agree with the level.** The message says that 62.78 "sits inside"
   57.32–61.12. 62.78 is above that zone.
4. **B: the alert fires on the wrong event.** The message says that only a daily close
   counts, but the condition is an intraday cross. The alert fires on a wick that means
   nothing. The explanation must check the daily close.
5. **D: the direction is "Crossing", up or down.** The plan is a pullback into the zone, so
   the alert must fire down. A cross up fires when price leaves the zone, and the message
   then is wrong.
6. **D: the alert is old.** It was created on 23 Sep and fired on 7 Oct. It is still active
   on 31 Oct. The explanation must tell the age and check the plan with new data.
7. **D: no R:R.** From 302.38 the R:R is 34.60 / 13.09 = 2.6 to T1, and 57.25 / 13.09 = 4.4 to T2.
8. **E: the dates disagree.** The alert was created on 7 Oct at 09:18, but the message
   calls the break "the resolution of the Oct 8 earnings print".
9. **E: no target, so no R:R.** A trailing exit is a correct choice at a new low. But the
   message must say that the plan has no R:R, and it must give a measure of the risk:
   126.60 − 123.85 = 2.75 (2.2%).

### Lessons for `alert-explain`

1. Start with the four answers, on four fixed lines: side, why, status, stop.
2. The server calculates the status. The model does not decide it. The status is one of:
   - **Triggered:** the confirmation is present (the 4H close, the daily close, or the volume).
   - **Waiting:** price is at the level, and the confirmation is not present yet. Tell what it needs.
   - **Failed:** price came back, or a daily close went past the invalidation. Cancel the plan.
   - **Only a wick:** for a close alert, the bar closed back on the other side.
3. A flip or invalidation alert is "no trade". Say what it cancels, and do not call it an entry.
4. The R:R uses the worse entry. When there is no target, say "no fixed target" and give the risk per share.
5. Tell the age of the alert in sessions. Build new facts at the time of the explanation.
6. Tell the earnings date when it is 10 sessions away or less, and the size rule.
7. The alert direction must agree with the plan. Our alerts already use `up` or `down`, never `cross`.
