# Backtest report — trade-check rules

Date: 2026-10-31. Scripts: `scripts/backtest/fetch.py`, `scripts/backtest/run.py`,
`scripts/backtest/manage.py`.

## Summary

We tested four rules of the `trade-check` skill on 18 years of daily bars for 62 US stocks.

- **Stop:** a stop at the level itself loses money. A buffer of 0.33 × daily ATR or more makes a little money. Keep "level + 0.5 × ATR of 4H".
- **Long MA:** EMA200 and SMA200 give the same answer on 94.6% of the events. Keep EMA200. The trend filter is important. The choice of MA is not.
- **Volume average:** the 20-bar and 25-bar averages separate good breaks from bad breaks best. Use 20 bars.
- **Management:** no management rule is clearly better. "Half at T1" has the same result as "one third at T1", with a smaller drawdown. The skill now uses "half at T1".

The edge of the retest plan is very small: about +0.03 to +0.06 R for each trade, before costs.

### Correction to the first version of this report

The first version counted every stop as −1 R. A stock that gaps through the stop loses more
than −1 R. 4.3% of the trades had such a gap. With gap exits at the open, the average R
fell by about 0.04 R. All numbers below include gap exits. The decisions did not change.

## Data

- 62 large US stocks, from 2008-01-02 to 2026-10-30, daily bars from FMP (split-adjusted).
- 13,961 BOS events. 12,162 of them had a retest within 20 bars.
- The tests use daily bars only. 0.5 × ATR(4H) is about 0.33 × ATR(1D). The CAT, STX, and
  NCLH samples give a ratio of 0.62 to 0.71 for ATR(4H) / ATR(1D).

## Test setup

The test is a mechanical copy of the skill's retest plan:

1. A swing low (high) is a pivot with 5 bars on each side.
2. A BOS is the first close through the latest swing low (high).
3. A limit order fills when price comes back to 0.1 × ATR before the broken level, within 20 bars.
4. T1 is the low (high) between the BOS and the retest.
5. T2 is the nearest older swing past T1. If there is none, T2 is T1 + the distance from the entry to T1.
6. The stop is the level + k × ATR(1D).
7. If one bar touches the stop and the target, the trade is a loss.
8. A gap through the stop exits at the open.
9. A trade that reaches neither in 40 bars exits at the close.

R is the result divided by the risk. +1 R is a gain of one risk unit. −1 R is a full stop.

## Test 1 — stop buffer

Same 8,950 trades for each buffer. All at T1.

| Buffer (× ATR 1D) | Win % | Average R | 95% range of average R | Profit factor |
|---|---|---|---|---|
| 0 (the level itself) | 11.6 | **−0.115** | −0.197 to −0.028 | 0.88 |
| 0.10 | 22.8 | −0.037 | −0.090 to +0.014 | 0.96 |
| 0.20 | 31.6 | +0.004 | −0.040 to +0.044 | 1.01 |
| **0.33 (≈ 0.5 × ATR 4H)** | 41.3 | **+0.040** | +0.005 to +0.074 | 1.06 |
| 0.50 | 50.0 | +0.048 | +0.019 to +0.078 | 1.09 |
| 0.75 | 58.7 | +0.060 | +0.036 to +0.084 | 1.13 |
| 1.00 | 64.3 | +0.057 | +0.037 to +0.077 | 1.15 |

Results:

- A stop at the level itself loses money. The 95% range is below zero.
- From 0.33 to 1.0, the average R is almost the same. The 95% ranges overlap.
- 0.75 and 1.0 are a little better than 0.33, but the difference is not proof.
- A wider stop also costs less in R for slippage and commission, because the risk unit is larger.

Decision: keep the user rule, level ± 0.5 × ATR(4H). The test supports it.

## Test 2 — EMA200 or SMA200

Stop 0.33 × ATR(1D), all at T1. "With the trend" is a short under the MA or a long over it.

| Filter | Trades | Win % | Average R | 95% range |
|---|---|---|---|---|
| No filter | 11,248 | 37.6 | +0.005 | −0.027 to +0.040 |
| With EMA200 trend | 7,957 | 38.6 | +0.028 | −0.013 to +0.066 |
| Against EMA200 trend | 3,291 | 35.2 | −0.048 | −0.114 to +0.017 |
| With SMA200 trend | 7,647 | 38.4 | +0.026 | −0.015 to +0.068 |
| Against SMA200 trend | 3,601 | 35.8 | −0.038 | −0.100 to +0.023 |
| EMA with, SMA against | 453 | 39.5 | −0.014 | −0.183 to +0.149 |
| SMA with, EMA against | 143 | 32.2 | −0.207 | −0.421 to +0.054 |

Results:

- The two MAs agree on 94.6% of the events. The difference is only in 596 trades.
- In those trades, EMA200 is a little better. The sample is small, and the 95% ranges overlap. This is not proof.
- Trades against the 200-day trend lost money on average. Trades with the trend made a little money. This supports the 0.5% size rule for a trade against the trend.

Decision: keep EMA200.

## Test 3 — volume average length

"High volume" is a BOS bar with volume ≥ 1.5 × the average. Follow-through is the
10-day move in the direction of the break, in ATR. The lift is the high-volume
follow-through minus the low-volume follow-through. This test does not use a stop, so the
gap correction does not change it.

| Length | Lift, all | Lift, 2008–2017 | Lift, 2017–2026 |
|---|---|---|---|
| **20** | **0.108** | 0.057 | **0.158** |
| 25 | 0.107 | **0.064** | 0.149 |
| 30 | 0.093 | 0.062 | 0.124 |
| 35 | 0.072 | 0.032 | 0.112 |

Results:

- A high-volume break follows through better than a low-volume break, for all lengths and in both periods.
- Shorter averages give a larger lift. 20 and 25 bars are the best. 35 bars is the worst.
- The lengths agree on 94% to 98% of the bars, so the difference is small.

Decision: use 20 bars. It is the best on all the data, and it is the usual default.

## Test 4 — trade management

Stop 0.33 × ATR(1D). The table uses the 6,077 trades that the skill would take: R:R to T2
of 2:1 or more, and with the EMA200 trend. "BE" is a move of the stop to the entry. The
trail is the high (low) of the last 3 daily bars, after T1.

| Variant | Win % | Average R | 95% range | Deepest drop (R) |
|---|---|---|---|---|
| A — all at T1 | 32.7 | +0.046 | −0.003 to +0.097 | 123 |
| B — all at T2 | 19.0 | +0.018 | −0.051 to +0.088 | 204 |
| **C — skill default: ⅓ at T1, BE at +1R, trail** | 25.2 | +0.031 | −0.019 to +0.081 | 115 |
| D — ⅓ at T1, trail, no BE | 27.7 | +0.038 | −0.018 to +0.097 | 184 |
| E — ⅓ at T1, BE at +1R, no trail | 25.3 | +0.020 | −0.030 to +0.069 | 116 |
| F — ½ at T1, BE at +1R, trail | 26.3 | +0.034 | −0.011 to +0.081 | **96** |

"Deepest drop" is the largest fall of the cumulative R, in date order. The trades overlap
in time, so this is a comparison number, not a real account drawdown.

Paired difference against C, on the same trades:

| Variant minus C | Average difference (R) | 95% range |
|---|---|---|
| A | +0.015 | −0.017 to +0.050 |
| B | −0.013 | −0.059 to +0.034 |
| D | +0.008 | −0.019 to +0.036 |
| E | −0.011 | −0.022 to +0.000 |
| F | +0.003 | −0.002 to +0.009 |

By period, the best variant changes. A is the best in 2008–2017 (+0.095 R). C and F are the
best in 2017–2026 (+0.027 and +0.029 R).

Results:

- No variant is clearly better than the default. All the 95% ranges include zero.
- Holding all to T2 (B) has the worst drop and the lowest win rate.
- The trail helps a little. E (no trail) is a little worse than C.
- BE at +1R makes the drop smaller. D (no BE) has a drop of 184 R, against 115 R for C.
- F (half at T1) has the same average R as C and the smallest drop.

Decision (user, 2026-10-31): use F, half at T1. F has the same return as C and a smaller drop.

## Limits of this test

- **Survivorship bias.** The 62 stocks are large companies today. Stocks that failed are not in the test.
- **Daily bars only.** The 4H ATR is an estimate (0.33 × ATR 1D). The 4H rejection trigger and the 4H trail are not in the test. The trail uses daily bars.
- **No costs.** The test has no commission, slippage, or borrow cost for shorts.
- **Conservative fills.** A bar that touches the stop and the target is a loss.
- **Not the AI.** The test copies the rules, not the judgment in the answers. The test has no news, earnings, or analyst data.
- **Trades overlap.** The test does not model a portfolio or a limit on open trades.
- **No 95% range for test 3.** I did not calculate a confidence range for the lift.

## What this means

The rules are correct, but the edge is very small. +0.03 to +0.06 R for each trade is
+0.03% to +0.06% of the account at 1% risk, before costs. After costs, the edge can be zero.
The skill must not promise a profit. The best use of the skill is to stop bad trades:

- A stop at the level itself (−0.115 R).
- A trade against the 200-day trend (−0.048 R).
- A plan that holds all to a far target (the largest drop).
