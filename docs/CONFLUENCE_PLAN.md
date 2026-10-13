# Plan — Confluence indicator (turn and breakdown levels)

Status: draft for user approval (2026-10-11).
Branch: `feat/confluence-indicator`, from `origin/main`.

User decisions (2026-10-11):

- The indicator shows one mode at a time. The user selects "turn" or "breakdown" in the
  settings. The default is "turn".
- The latch is in scope. When the latch is on, a small handle at the top of the chart shows
  the latch date. The user drags the handle to move the latch date (section 6.3).

Decisions D1–D10 (section 8) use the recommendations. The user can change them before the
implementation starts.

**Implementer:** read `AGENTS.md` first. All output for the user (reports, commit
messages, the PR) must be in ASD-STE100 style.

## 1. Goal

Add one indicator, "Confluence". It combines two TradingView scripts by the user into one indicator with two modes:

- **Turn** (default), from Turn Confirmation Levels. It finds the strongest cluster of resistance levels above the price and marks a volume-confirmed close above it (a **breakout**).
- **Breakdown**, from Breakdown Confluence Levels. It finds the strongest cluster of support levels below the price and marks a volume-confirmed close below it (a **breakdown**).

The two scripts use the same level sources, the same clusters, and the same ranking. Only the direction is different. The `mode` setting selects the direction. The indicator shows one mode at a time. To see both, the user adds the indicator two times.

## 2. Source scripts

The scripts are in the user's own repository, so this is a direct port. The clean-room rule of `docs/LIQUIDITY_PLAN.md` does not apply. The implementer can read the scripts:

- Repository: `datascienceqing/pine-indicators`, commit `dd7559a`.
- `indicators/turn_confirmation_levels.pine` (mode "turn").
- `indicators/breakdown_confluence_levels.pine` (mode "breakdown").

Section 4 is the specification. Where section 4 and a script do not agree, section 4 is correct. Section 4 differs from the scripts in these places:

1. **Breakout bug.** In the Turn script, the trigger comes only from clusters above the close of the current bar. The script then tests `close > triggerPrice` on the same bar. That test is never true, so the breakout signal never fires. The Breakdown script fixed the same problem with the trigger of the previous bar. Section 4.6 uses that fix for both modes.
2. **Redundant test.** The Turn script also tests `close[1] <= triggerPrice`. With the previous-bar trigger, this test is always true. Section 4.6 removes it.
3. **Latch in both modes.** Only the Breakdown script has a latch. Section 4.9 adds the mirror of it to mode "turn" (decision D9).
4. **Latch date.** In Pine, the user selects the latch bar with `input.time(confirm=true)`. Here, the user drags a handle on the chart (section 6.3).
5. **Out of scope.** Section 3 lists the parts of the scripts that we do not port.

## 3. Scope

In scope:

- The two modes, "turn" and "breakdown", and the `mode` setting.
- The level sources: Fibonacci levels, moving averages, swing extremes, and pivots.
- Clusters, and the primary and secondary trigger.
- Breakout events (turn) and breakdown events (breakdown), with the volume check. Breakdown events also have the close-quality check.
- The invalidation level, and the retest line after a breakdown.
- The latch in both modes (section 4.9), and the latch handle on the chart (section 6.3).
- Drawing on the price pane: cluster boxes, trigger lines, source lines, labels, and event marks.
- Settings in the indicator editor. The editor needs decimal number fields (decision D5) and fields that show only in one mode (decision D2).
- Save in layouts (server workspace store), including the latch date.

Out of scope (decision D4):

- Both modes in one indicator at the same time.
- Alerts. RhinoView had no alert system then. Alerts on the latched level came later:
  `docs/ALERTS_PLAN.md`, section 11.
- Stop, target, and R:R (Breakdown script only).
- The info table and the "strong volume" row (Turn script only).
- The `/api/indicator` test endpoint. The output is drawings, not lines.

## 4. Specification

All indexes are bar indexes in the loaded bars, oldest first. `t` is the current bar. Each value for bar `t` uses only bars `0..t`.

### 4.1 Level sources at bar `t`

| Source | Value | Undefined when |
|---|---|---|
| Swing high `H` | highest `high` of bars `t-N+1..t` | `t < N-1` |
| Swing low `L` | lowest `low` of bars `t-N+1..t` | `t < N-1` |
| Fibonacci | `L + (H-L) × r`, for r = 0.236, 0.382, 0.5, 0.618, 0.786 | `H` is undefined |
| Moving averages | EMA 10, 20, 50 and SMA 50, 100, 200 of `close` | warmup of each average |
| Pivots | the retained pivot highs and pivot lows (4.2) | — |

- `N` is `swingLookback`.
- Use the existing kernels in `src/indicators/math.ts`. The EMA seeds with the SMA of the first values, as in Pine.
- The candidate list at bar `t` holds every defined value in the table: up to 13 fixed values, plus the pivots. Skip undefined values.

### 4.2 Pivots

- Use the pivot rule of the Liquidity indicator, with separate left and right counts (`pivotLeft`, `pivotRight`). Bar `p` is a pivot high when `high[p]` is greater than the high of each of the `pivotLeft` bars before it, and greater than or equal to the high of each of the `pivotRight` bars after it. A pivot low is the mirror.
- A pivot is **confirmed** at bar `p + pivotRight`. Before that bar, it is not in any list.
- A confirmed pivot is **retained** while `t - p <= pivotMaxAge`.
- Each list (highs, lows) keeps at most the 50 most recent retained pivots. This number is a safety cap, not a setting.
- Move the pivot functions from `src/indicators/liquidity.ts` to a shared module, and use them in both indicators. The Liquidity output must not change.

### 4.3 Side of the price

- Mode "turn" uses the candidates with `value > close[t]` (resistance).
- Mode "breakdown" uses the candidates with `value < close[t]` (support).
- A candidate equal to `close[t]` is not used.
- The math computes only the side of the selected mode.

### 4.4 Clusters

1. Sort the candidates of the side in ascending order.
2. Start a cluster with the first value. The cluster has a `bottom`, a `top`, and a `count`.
3. Let `tol = close[t] × tolerancePct / 100`. Let `maxWidth = tol × bandWidthMult`, or no limit when `bandWidthMult` is 0.
4. For each next value `v`: if `v - top <= tol` and `v - bottom <= maxWidth`, add `v` to the cluster (`top = v`, `count + 1`). If not, close the cluster and start a new one with `v`.
5. Close the last cluster.

Equal values are separate levels. Each one adds 1 to the count.

### 4.5 Triggers

A cluster is **eligible** when:

| Mode | Distance rule | Count rule |
|---|---|---|
| turn | `bottom >= close[t] × (1 + turnMinDistancePct / 100)` | `count >= turnMinConfluence` |
| breakdown | `top <= close[t] × (1 - breakdownMinDistancePct / 100)` | `count >= breakdownMinConfluence` |

Rank the eligible clusters. A higher count ranks first. On equal counts, the cluster nearer to the price ranks first: the lower `top` in mode "turn", the higher `top` in mode "breakdown". The first cluster is the **primary**. The second cluster is the **secondary**.

The **trigger price** is the `top` of the primary cluster (decision D1):

- Mode "turn": the top is the far edge. A breakout must clear the whole band.
- Mode "breakdown": the top is the near edge. A breakdown fires on the first close into the band.

With no eligible cluster, there is no trigger at bar `t`.

### 4.6 Events

Let `T[t]` be the trigger at bar `t`. Let `volAvg[t]` be the SMA of `volume` over `volumeLength` bars, including bar `t`.

- **Volume check:** `volAvg[t]` is defined and `volume[t] >= volAvg[t] × volumeMult`.
- **Breakout at bar `t`** (mode "turn", `t >= 1`): `T[t-1]` exists, `close[t] > T[t-1]`, and the volume check passes.
- **Breakdown at bar `t`** (mode "breakdown", `t >= 1`): `T[t-1]` exists, `close[t] < T[t-1]`, the volume check passes, and the close-quality check passes.
- **Close-quality check:** let `range = high[t] - low[t]`. The check passes when `range <= 0`, or when `(close[t] - low[t]) / range <= closeQuality`. Only mode "breakdown" uses this check (decision D3).
- Each event records the bar, the level `T[t-1]`, and the count of the primary cluster at bar `t-1`.
- Events can fire on consecutive bars. The scripts do the same.
- When the latch holds at bar `t`, section 4.9 replaces these rules for bar `t`.

### 4.7 Invalidation

The two scripts use different rules. We keep both rules (decision D3):

- Mode "turn": the most recent confirmed pivot low of any age.
- Mode "breakdown": the most recent retained pivot high (4.2).

### 4.8 Retest line (mode "breakdown" only)

- After a breakdown, the **broken level** is the level of the most recent breakdown.
- The retest line starts at that breakdown bar and goes to the last bar.
- The retest zone is `close >= level × (1 - tolerancePct / 100)`. The script uses this only for an alert, so we draw only the line.
- Mode "turn" has no retest line, as in the Turn script.

### 4.9 Latch

The latch freezes the primary and secondary clusters at a date that the user selects. Then the user can see if the price later breaks that frozen level.

- The **latch date** is `latchTime`, in Unix seconds. The value 0 means "no date". With no date, the latch has no effect.
- The latch is **active** at bar `t` when `latch` is "on", `latchTime > 0`, and `time[t] >= latchTime`.
- At a bar where the latch is not active, clear the lock and the fired flag.
- At the first active bar where a primary cluster exists, **lock** the primary and the secondary clusters of that bar (bottom, top, count). The lock does not change while the latch stays active.
- The latch **holds** at bar `t` when it is active and a lock exists.
- While the latch holds, the drawing uses the locked clusters, and the label adds "(latched)".
- While the latch holds, the event reference is the locked `top` of the same bar, with no lag. The event count is the locked count.

Events while the latch holds:

| Step | Mode "turn" | Mode "breakdown" |
|---|---|---|
| 1. Re-arm | if `close[t] < lockTop`, clear the fired flag | if `close[t] > lockTop`, clear the fired flag |
| 2. Event | `close[t] > lockTop`, the volume check passes, and the fired flag is clear | `close[t] < lockTop`, the volume check passes, the close-quality check passes, and the fired flag is clear |
| 3. After an event | set the fired flag | set the fired flag |

- Do the steps in this order on each bar. The re-arm comes before the event test.
- Without the fired flag, every bar past a frozen level gives an event. The re-arm lets a new break give an event again after the price comes back.
- The previous-bar trigger `T[t-1]` (4.6) always follows the live clusters, also while the latch holds. When the user turns the latch off, events continue with the correct lag.
- The latch does not change the invalidation level (4.7) or the retest line (4.8). A breakdown event while the latch holds also sets the broken level.

### 4.10 Output

`computeConfluence(bars, params)` returns:

- `events`: every event of the selected mode in the loaded bars (4.6, 4.9).
- `last`: the state at the last bar. This holds the primary and secondary clusters (bottom, top, count), the trigger, and the invalidation level. It also holds the defined source values (4.1) and, in mode "breakdown", the broken level with its bar (4.8).
- `latch`: the index of the first bar with `time >= latchTime` (or null), and whether the latch holds at the last bar. When the latch holds, `last` holds the locked clusters.

### 4.11 No look-ahead

The events for bars `0..k` must not change when more bars arrive. A test checks this property on many cut points, in both modes, with the latch off and on.

## 5. Settings

New contract type in `shared/types.ts`:

```ts
interface ConfluenceParams {
  mode: 'turn' | 'breakdown';         // default 'turn'
  swingLookback: number;              // N, integer 20..1000, default 250
  tolerancePct: number;               // decimal 0.05..5, default 0.75
  bandWidthMult: number;              // decimal 0..20, default 0 (no limit)
  pivotLeft: number;                  // integer 1..25, default 5
  pivotRight: number;                 // integer 1..25, default 5
  pivotMaxAge: number;                // bars, integer 10..5000, default 250
  turnMinConfluence: number;          // integer 1..20, default 1
  turnMinDistancePct: number;         // decimal 0..20, default 0
  breakdownMinConfluence: number;     // integer 1..20, default 3
  breakdownMinDistancePct: number;    // decimal 0..20, default 0.5
  volumeLength: number;               // integer 1..500, default 10
  volumeMult: number;                 // decimal 1..10, default 1.5
  closeQuality: number;               // decimal 0.1..1, default 0.5 (breakdown only)
  sources: 'both' | 'fibs' | 'mas' | 'none';  // default 'both'
  latch: 'off' | 'on';                // default 'off'
  latchTime: number;                  // Unix seconds, integer >= 0, default 0 (no date)
}
```

- `latch` is a select field in the editor. `latchTime` is not an editor field. Only the latch handle changes it (section 6.3).
- When the user turns the latch off, `latchTime` keeps its value. When the user turns the latch on again, the handle comes back at the same date.

- The defaults match the two scripts, so the result matches the user's TradingView charts.
- The editor shows only the fields of the selected mode (decision D2):
  - Mode "turn": `turnMinConfluence` and `turnMinDistancePct`.
  - Mode "breakdown": `breakdownMinConfluence`, `breakdownMinDistancePct`, and `closeQuality`.
- The hidden fields keep their values. When the user changes the mode back, the old values return.
- The param check validates all fields in both modes. A stored layout is then valid in both modes.

**Name trap:** `isLiquidityParams` in `src/panes/config.ts` tests `'lookback' in p`, and `isMovingAverageParams` tests `'period' in p`. For this reason, `ConfluenceParams` has no field named `lookback` or `period`. Test `isConfluenceParams` with `'swingLookback' in p`, before the other narrowing helpers.

## 6. Design

| Part | File | Notes |
|---|---|---|
| Math | `src/indicators/confluence.ts` | Pure: `computeConfluence(bars, params) → { events, last }`. Per bar: up to 113 candidates, sort, clusters. O(n × c log c). |
| Shared pivots | `src/indicators/pivots.ts` | The pivot functions, moved from `liquidity.ts`. |
| Contract | `shared/types.ts`, `docs/CONTRACT.md`, `src/indicators/types.ts` | Kind `confluence`, placement `overlay`, params, bounds, defaults, `LINE_KEYS.confluence = []`. |
| Param check | `src/indicators/params.ts` | Integers in bounds, decimals finite and in bounds, enum fields in their sets. The server store uses the same check. |
| Editor | `src/panes/config.ts`, `src/panes/ParamsEditor.tsx` | Decimal fields (D5). Fields for one mode only (D2). Three select fields (`mode`, `sources`, `latch`) in `PARAM_CHOICES`; `mode` is first in the editor. `sanitizeParams` keeps `latchTime`. |
| Latch handle | `src/panes/confluence/LatchHandle.tsx`, `src/ui/ChartPanel.tsx` | A DOM element in the chart overlay (section 6.3). It saves with `setParams` from `useIndicators`, as the editor does. |
| Chart access | `src/chart/PriceChart.ts`, `src/chart/ChartView.tsx` | Expose what the handle needs: time to x, x to bar index, the price pane height, and a subscription to the visible range. Do not expose the chart object. |
| Text | `src/i18n/en.ts`, `src/i18n/zh.ts` | Field labels and mode names in both languages. The kind name stays in English, as for the other indicators. |
| Drawing | `src/panes/confluence/ConfluencePrimitive.ts`, `paintConfluence.ts` | Series primitive on the price series, like Liquidity. No autoscale info. |
| Wiring | `src/panes/IndicatorPanes.ts`, `src/panes/testing/fakeCompute.ts` | Same path as Liquidity. |
| Server | `server/workspace/schemas.ts` | Add the kind to `KINDS`. |

The math runs on all loaded bars and is memoized on the bars and the params, as for Liquidity.

### 6.1 Drawing

The current levels come from `last` (4.10). They start at bar `last - swingLookback`, or at the first bar when there are fewer bars, and go to the right edge of the pane. The Turn script draws them the same way.

The mode colour is the theme up colour in mode "turn" and the theme down colour in mode "breakdown" (decision D6).

| Item | Look | Colour |
|---|---|---|
| Primary cluster | box from `bottom` to `top`, solid trigger line at the trigger | mode colour |
| Secondary cluster | lighter box, dashed line at its `top` | mode colour, at lower opacity |
| Label | at the right end, for example "Trigger 4× 123.45" and "Secondary 2× 125.10" | mode colour |
| Invalidation | dashed line, label "Invalidation 97.20" | theme text colour |
| Sources | thin dotted lines, labels such as "Fib 0.618 101.20" or "SMA 200 99.80" | the indicator colour |
| Retest line (breakdown) | dashed line from the breakdown bar, label "Retest 98.10" | mode colour |
| Event mark | small triangle: below the bar for a breakout, above the bar for a breakdown | mode colour |

- The `sources` setting chooses the source lines. Mode "turn" draws all chosen source lines, as the Turn script does. Mode "breakdown" draws only the chosen source lines below the close, as the Breakdown script does.
- Event marks show for all events in the visible range (decision D7). We do not change the candle colours.
- When two labels are nearer than the label height, move the lower label down.

### 6.2 Legend and title

The title shows the mode, for example "CONF Turn (250)" or "CONF Breakdown (250)". The legend shows the title only. The labels on the chart show the trigger prices (decision D8).

### 6.3 Latch handle

When `latch` is "on" and the indicator is visible, a small handle shows at the top edge of the price pane. The handle marks the latch bar: the first bar with `time >= latchTime`.

**Look**

- A small tab at the top of the price pane, with the latch date. On a daily or longer timeframe, the date is "Mar 12". On an intraday timeframe, the date has the time, "Mar 12 10:30".
- A thin dashed vertical line goes from the tab down through the price pane, at the x of the latch bar.
- The tab and the line use the mode colour (6.1).
- Two Confluence indicators can have a latch at the same time. Each one has its own handle. When two tabs overlap, the second tab moves down by one tab height.

**First position**

- When the user turns the latch on and `latchTime` is 0, the handle takes the bar at the centre of the visible range. It saves that bar's time as `latchTime` at once.
- When `latchTime` is not 0, the handle uses the saved date.

**Move with the pointer** (mouse, pen, or touch)

1. The user presses the tab. The handle captures the pointer, so the chart does not pan.
2. The tab and the line follow the pointer. They snap to the nearest bar and stay between the first and the last loaded bar.
3. The user releases the tab. The handle saves the new bar time as `latchTime` with `setParams`. If the bar did not change, the handle does not save.
4. During the drag, the indicator does not recompute. It recomputes once, after the save. A recompute can take tens of milliseconds on a long history.
5. The Escape key during the drag cancels the drag. The handle goes back to the saved date.

**Move with the keyboard**

- The tab is a button with a label, for example "Latch date Mar 12. Use the arrow keys to move it."
- The Left and Right arrow keys move the handle one bar. With Shift, they move 10 bars.
- The handle saves 500 ms after the last key press, so a series of key presses gives one save.

**Latch date outside the visible range** (decision D10)

- The handle stays at the nearest edge of the pane, with an arrow to the latch date: "◀ Mar 12" or "Mar 12 ▶".
- A click on that tab, with no drag, scrolls the chart so that the latch bar is in view.
- A drag from that tab works as in the visible range.
- When the latch date is before the first loaded bar, the latch is active from bar 0 (4.9). The handle stays at the left edge with the arrow.

**Saves**

- A save changes the layout, in the same way as a change in the editor. The workspace store saves the new `latchTime` with the layout.
- A change of the timeframe or the symbol keeps `latchTime`. On the new bars, the latch bar is the first bar with `time >= latchTime`.

## 7. Steps and gates

Each step ends with typecheck, lint, and all tests at 0 failures.

1. **Specification review.** If a rule in section 4 is ambiguous or contradicts another rule, choose the simplest reading. Write it down in the PR under **Risks**, and continue.
2. **Shared pivots.** Move the pivot functions. The Liquidity tests must pass with no change.
3. **Contract and param check.** Types, bounds, defaults, server store. Tests for valid and invalid params, including decimals and the two enum fields.
4. **Math.** `computeConfluence` and its tests, in both modes:
   - One small hand-made bar series for each rule in section 4.
   - A breakout that the Turn script misses (section 2, item 1), to prove the fix.
   - Edge cases: a candidate equal to the close, equal candidates, a gap exactly equal to `tol`, `bandWidthMult` 0 and greater than 0, a tie on count, a zero bar range, an undefined volume average, fewer than `N` bars.
   - The latch (4.9) in both modes: the lock at the first active bar with a primary, no event lag while the latch holds, one event per break, the re-arm, a latch date before the first bar, `latchTime` 0, and the latch turned off again.
   - The no-look-ahead property (4.11) on synthetic bars at many cut points.
   - Time: 10 000 bars with default params in less than 200 ms.
5. **Editor.** Decimal fields, the three select fields, and the fields for one mode only. Tests include a mode change and a change back, with the hidden values kept. `latchTime` stays in the params after an edit.
6. **Drawing and wiring.** Primitive and painter tests with the fake chart, in both modes and with the latch held. Integration tests in `IndicatorPanes.test.ts`, including a mode change and a chart type change.
7. **Latch handle.** Component tests with the fake chart:
   - The handle shows only when the latch is on and the indicator is visible.
   - The first position is the centre of the visible range, and it saves at once.
   - A drag snaps to bars, stays inside the loaded bars, and saves once on release. A release on the same bar does not save. Escape cancels.
   - The arrow keys move one bar or 10 bars, with one save after the last key press.
   - A latch date outside the visible range pins the tab to the edge, and a click scrolls the chart to the latch bar.
   - The chart does not pan during a drag.
8. **Verification.**
   - Mutation checks on at least four rules: the previous-bar trigger, the tie rule, the close-quality check, the latch re-arm.
   - Browser check with synthetic data, on 1D and 5m, in both modes, in the dark theme and the light theme.
   - Browser check of the latch handle: a drag with the mouse, the arrow keys, a tab at the edge, and a reload that keeps the latch date.
   - Comparison with TradingView: the user selects one symbol and one date. The user writes down the trigger prices and counts from the two scripts. We compare them with our values in each mode. For the latch, compare mode "breakdown" with the Breakdown script at the same latch bar. Mode "turn" has no latch in Pine, so there is no reference for it. If the implementer cannot do this, write it under **Not verified**.
9. **PR.** Based on `main`, with the STE sections from `AGENTS.md`.

## 8. Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| D1 | Which edge of the primary cluster is the trigger? | Keep each script: the far edge (top) in mode "turn", the near edge (top) in mode "breakdown". The result then matches the TradingView charts. |
| D2 | Minimum confluence and minimum distance have different defaults in the two scripts. How do we keep both? | One field for each mode. The editor shows only the fields of the selected mode. Each mode keeps its own values. |
| D3 | The scripts differ in close quality, invalidation, and retest. Mirror them, or keep each script? | Keep each script for now. A later change can make the two modes symmetric. |
| D4 | Which parts stay out of the first version? | Alerts, stop / target / R:R, info table, strong volume. The latch is in scope (user decision). |
| D5 | How do the decimal settings work? | Add decimal number fields to the editor (`step` per field). The user types 0.75 and 1.5, as in TradingView. |
| D6 | Colours? | Up colour in mode "turn", down colour in mode "breakdown". The indicator colour sets the source lines. |
| D7 | How do we show an event on the chart? | A triangle mark at the bar. We do not change the candle colour: the price series also has line and area types, and other indicators use the candles. |
| D8 | What do the title and the legend show? | The title shows the mode, for example "CONF Turn (250)". The legend shows the title only. The labels on the chart show the trigger prices. |
| D9 | Only the Breakdown script has a latch. Does mode "turn" get one? | Yes, the mirror (4.9): the event is a close above the locked top, and the re-arm is a close below it. One `latch` setting then works the same in both modes. |
| D10 | What does the handle do when the latch date is outside the visible range? | It stays at the nearest edge with an arrow. A click scrolls the chart to the latch bar. A hidden handle cannot be found, and a handle that moves the chart by itself is a surprise. |

## 9. Risks

- **History.** The swing levels need `swingLookback` bars (250), and SMA 200 needs 200 bars. On a short history, fewer sources exist, so the clusters and the triggers differ from TradingView until more bars load.
- **Pivot ties.** For equal highs or lows, our pivot rule can differ from `ta.pivothigh` and `ta.pivotlow` in Pine. The result can then differ by one pivot.
- **Clutter.** Up to 11 source lines, 2 cluster boxes, an invalidation line, labels, and marks on one pane can hide the candles. The `sources` setting reduces it.
- **Repeated events.** A breakdown can fire on many consecutive bars in a strong decline, because the trigger moves with the price. The scripts do the same.
- **Asymmetry.** Decisions D1 and D3 keep two different rule sets for the two modes. This is for parity with the scripts, but it can surprise a user who expects a mirror.
- **Mode-dependent fields.** The editor now shows a field only in one mode. This is a new editor feature, so it needs its own tests.
- **Latch and history.** When older bars load, the values at the latch bar can change, because the averages and the pivots depend on the history. The lock can then change. The change is largest when the latch date is before the first loaded bar: then the first active bar also moves.
- **Latch in mode "turn".** It has no reference in Pine (D9), so only this plan and the tests define the correct result.
- **Pointer conflicts.** The handle sits above the chart canvas. A drag on the handle must not pan the chart, and a drag elsewhere must pan the chart as before. Section 7, step 7, tests both.
- **Many saves.** Each drag or key series gives one layout save. The save uses revisions (workspace invariant 5), so two open tabs can give a conflict, as for any other layout change.
- **Frozen files.** This plan changes `shared/types.ts`, `src/indicators/types.ts`, and `docs/CONTRACT.md`. The user must approve these changes with this plan.
- **Older branches.** A branch without the `confluence` kind drops this indicator from the workspace file when the server starts. Since PR #6, it does not drop the whole workspace.
