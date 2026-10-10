# Plan — Liquidity indicator (zones and sweeps)

Status: approved for implementation by a single agent (user decision, 2026-10-09).
Branch: `feat/liquidity-indicator`, on top of `feat/vpvr-indicator`.

Decisions D1–D5 (section 8) use the recommendations. The user can change them before the
implementation starts.

**Implementer:** read `AGENTS.md` first. All output for the user (reports, commit
messages, the PR) must be in ASD-STE100 style.

## 1. Goal

Add one indicator, "Liquidity". It does two jobs on the price pane:

1. It marks **liquidity zones** at swing highs and swing lows. A zone shows how many bars and how much volume traded inside it.
2. It marks **sweeps**. A sweep is a bar that goes through a zone level and then closes back.

Each sweep shows the volume of the zone that it took. This link is the reason to combine the two jobs.

## 2. Clean-room rule

The user chose our own version, not a port of the LuxAlgo scripts (CC BY-NC-SA 4.0).

- Section 4 of this plan is the specification. It describes the behaviour in our own words.
- The implementation uses only this plan. Do not open, copy, or translate the Pine scripts.
- Use our own names, structure, defaults, and colours. Do not use the names "Liquidity Swings" or "Liquidity Sweeps".
- The concepts (pivots, zones, sweeps, retests) are general technical-analysis ideas. The code is new.

The author of this plan read the Pine scripts. The implementer must not read them. The scripts are not in this repository; do not search for them on the web.

## 3. Scope

In scope:

- Swing pivots, zones, touch count and volume per zone, zone break.
- Wick sweeps, and breakout-then-retest events.
- Drawing on the price pane: zone boxes, level lines, sweep boxes, volume labels.
- Settings in the indicator editor, including two new select fields.
- Save in layouts (server workspace store).

Out of scope:

- Intrabar precision (it needs 1-minute data; FMP Starter does not serve 1m).
- Alerts.
- The `/api/indicator` test endpoint (the output is drawings, not lines).

## 4. Specification

All indexes are bar indexes in the loaded bars, oldest first. `L` is the pivot lookback.

### 4.1 Pivots

- Bar `i` is a **pivot high** when `high[i]` is greater than the high of each of the `L` bars before it, and greater than or equal to the high of each of the `L` bars after it.
- Bar `i` is a **pivot low** when `low[i]` is less than the low of each of the `L` bars before it, and less than or equal to the low of each of the `L` bars after it.
- A pivot is **confirmed** at bar `i + L`. Nothing that depends on a pivot can happen before its confirmation bar.
- The last `L` bars cannot hold a confirmed pivot.

The asymmetric rule (strict on the left, not strict on the right) gives one pivot for a flat top of equal highs: the first bar.

### 4.2 Zones

Each pivot makes one zone. The zone has a `top` and a `bottom`:

| Pivot | Zone mode "wick" (default) | Zone mode "range" |
|---|---|---|
| High | top = `high[i]`, bottom = `max(open[i], close[i])` | top = `high[i]`, bottom = `low[i]` |
| Low | top = `min(open[i], close[i])`, bottom = `low[i]` | top = `high[i]`, bottom = `low[i]` |

The **level** of a zone is its outer edge: `top` for a high zone, `bottom` for a low zone.

### 4.3 Zone life

- A zone is **active** from its confirmation bar.
- A zone **breaks** at the first bar `j` after its confirmation where the close goes past the level: `close[j] > top` for a high zone, `close[j] < bottom` for a low zone.
- A zone **expires** when it is `maxAge` bars old (counted from the pivot bar) and it did not break.
- A zone that broke or expired is **closed**. It stays on the chart, with its end bar.

### 4.4 Touches and volume

- A bar **touches** a zone when its range overlaps the zone: `low < top` and `high > bottom`.
- For each zone, count the touches and add up their volume. Count the bars after the pivot bar, up to and including the bar where the zone closes. The pivot bar itself does not count.
- A zone is **shown** only when its touch count is at least `minTouches`.

Note: the count includes bars between the pivot bar and the confirmation bar. These bars are history at confirmation time, so this is not look-ahead.

### 4.5 Sweeps

A sweep can happen only on a bar after the zone's confirmation bar.

| Event | High zone (level `p` = top) | Low zone (level `p` = bottom) |
|---|---|---|
| Wick sweep | `high[j] > p` and `close[j] <= p` | `low[j] < p` and `close[j] >= p` |
| Retest after a break | the zone broke earlier; then `low[k] < p` and `close[k] > p` | the zone broke earlier; then `high[k] > p` and `close[k] < p` |

- A wick sweep can happen only while the zone is active. A wick sweep does not close the zone.
- Each zone gives at most one wick sweep (the first one) and at most one retest (the first one).
- A retest can happen up to `maxAge` bars after the pivot bar.
- The sweep mode chooses the events: "wicks" (default), "retests", or "both".
- Direction: a wick sweep of a high zone and a retest of a low zone are **bearish**. A wick sweep of a low zone and a retest of a high zone are **bullish**.

### 4.6 Sweep area

Each sweep has an area box:

- Vertical: from the level `p` to the wick extreme of the sweep bar (`high[j]` for bearish, `low[j]` for bullish).
- Horizontal: from the sweep bar to the first later close past the wick extreme, or `sweepExtend` bars, or the last bar. The first of these ends it.

### 4.7 The combination

- Each sweep carries the touch count and the volume of its zone, at the sweep bar.
- The sweep label shows that volume, for example "1.2M".

### 4.8 No look-ahead

The output for bars `0..k` must not change when more bars arrive, except for items that are still open at bar `k`. A test checks this property on many cut points.

## 5. Settings

New contract type in `shared/types.ts`:

```ts
interface LiquidityParams {
  lookback: number;        // L, 2..100, default 10 (decision D1)
  zoneMode: 'wick' | 'range';                 // default 'wick'
  sweepMode: 'wicks' | 'retests' | 'both';    // default 'wicks'
  minTouches: number;      // 0..100, default 0
  maxAge: number;          // bars, 10..5000, default 300
  sweepExtend: number;     // bars, 1..500, default 20
}
```

Colours: bullish items use the theme up colour, bearish items the theme down colour. The indicator colour sets the level lines (decision D4).

## 6. Design

| Part | File | Notes |
|---|---|---|
| Math | `src/indicators/liquidity.ts` | Pure: `computeLiquidity(bars, params) → { zones, sweeps }`. O(n × active zones). |
| Contract | `shared/types.ts`, `docs/CONTRACT.md`, `src/indicators/types.ts` | Kind `liquidity`, params, bounds, defaults, `LINE_KEYS.liquidity = []`. |
| Param check | `src/indicators/params.ts` | Numbers in bounds; enum fields in their sets. The server store uses the same check. |
| Editor | `src/panes/config.ts`, `src/panes/ParamsEditor.tsx` | New `PARAM_CHOICES` table for select fields. Move the MA "source" select to it too. |
| Drawing | `src/panes/liquidity/LiquidityPrimitive.ts`, `paintLiquidity.ts` | Series primitive on the price series, like VRVP. x from `timeScale().logicalToCoordinate`, y from `priceToCoordinate`. Draws only items that overlap the visible range. |
| Wiring | `src/panes/IndicatorPanes.ts` | Same path as VRVP: create, update on bars or params, detach on remove. |
| Server | `server/workspace/schemas.ts` | Accept the kind. |

The math runs on all loaded bars, not only the visible bars: a zone depends on history. The result is memoized on the bars and the params.

Drawing, per zone: a box from the pivot bar to the end bar, between top and bottom. A level line at the level, solid while active, dashed after a break. A volume label near the pivot. Per sweep: the area box, and a short thick mark on the sweep bar.

## 7. Steps and gates

Each step ends with typecheck, lint, and all tests at 0 failures.

1. **Specification review.** Done: the user approved the plan. If a rule in section 4 is ambiguous or contradicts another rule, choose the simplest reading, write it down in the PR under **Risks**, and continue.
2. **Contract and param check.** Types, bounds, defaults, server store. Tests for valid and invalid params.
3. **Math.** `computeLiquidity` and its tests:
   - One small hand-made bar series for each rule in section 4.
   - Edge cases: flat tops, equal lows, a close exactly at the level (a sweep, not a break), a break on the first bar after confirmation, fewer than `2L + 1` bars, zero volume.
   - The no-look-ahead property (4.8) on synthetic bars at many cut points.
4. **Editor select fields.** Tests for the selects, and for the moved MA source.
5. **Drawing and wiring.** Primitive and painter tests with the fake chart. Integration tests in `IndicatorPanes.test.ts`, including a chart type change.
6. **Verification.**
   - Mutation checks on at least three rules (pivot strictness, break rule, one sweep per zone).
   - Browser check with synthetic data, on 1D and 5m.
   - A cloud session has no FMP key. If no key is available, write the FMP browser check under **Not verified**. The user does it locally.
   - Optional: an independent review by a reviewer agent against section 4 only.
7. **PR.** PR #4, based on `feat/vpvr-indicator`, with the STE sections from `AGENTS.md`.

## 8. Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| D1 | One pivot lookback for zones and sweeps, or two? | One, default 10. Sweeps must use the zone pivots to carry the zone volume. |
| D2 | Name in the menu? | "Liquidity" (title "LIQ (10)"). |
| D3 | How many closed zones stay on the chart? | All zones of the last `maxAge` bars. No count limit at the start. |
| D4 | What does the indicator colour change? | The level lines. Zones and sweeps keep the up and down colours. |
| D5 | Labels on zones, on sweeps, or both? | Both: the zone shows its volume; the sweep shows the volume it took. |

## 9. Risks

- **Clean room.** The plan author read the Pine scripts. The implementer did not (section 2).
- **Clutter.** Many zones, sweeps, VRVP, and Volume on one pane can hide the candles. `minTouches` and `maxAge` reduce it.
- **Late zones.** A zone appears `L` bars after its pivot bar. This is correct (section 4.1), but users can expect it earlier.
- **No reference output.** Our rules differ from the LuxAlgo scripts on purpose, so there is no oracle. Only the specification and the tests define correct output.
- **Volume quality.** FMP intraday volume was fractional before the rounding fix; daily data is the most reliable.
- **Performance.** Long histories (5000+ bars) with a small lookback can make many zones. The active-zone list stays small, because zones close; a test with 10 000 bars checks the time.
