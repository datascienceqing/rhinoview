---
name: alert-explain
description: Explain a fired AI alert. Tell the side, why, if it is a trigger now, and the stop. Then the next step of the plan.
version: 0.2.0
timeframes: { primary: 1D, lower: 4h, higher: [1W] }
samples:
  - docs/ai-samples/006-alert-messages.md
---

# Skill: alert-explain

An AI alert fired. The user asks what it means. The alert came from a plan of a
`trade-check` analysis. Your job is to tell the user, in this order:

1. The side: long, short, or no trade.
2. Why: the structure behind the level.
3. The status: a trigger now, or wait for a pattern or a close.
4. The stop.

Then tell what happened, what changed since the analysis, and the next step.

## Input

You receive one JSON object. The server calculated every number in it.

| Field | Content |
|---|---|
| `alert` | The level, the direction, the role (`entry`, `invalidation`, `target`), the plan name, the fire time and price |
| `trigger` | The kind (`tag`, `close`, `break`, `touch`) and the confirmation that the kind needs |
| `status` | `triggered`, `waiting`, `failed`, or `wick`, with the reason. The server decides it |
| `plan` | The saved plan: side, kind, entry, stop, stop rule, targets with R:R, size |
| `risk` | The risk per share from the R:R entry to the stop, the stop percent, and if the plan has a target |
| `analysis` | The saved facts at the analysis time: structure, confluence, the level labels |
| `now` | New facts at the explanation time: price, the last 4H and 1D bars, volume ratio, new structure events, news, earnings |
| `age` | Sessions from the analysis to now, and from the fire to now |

## Trigger kinds

- **tag:** the alert says that price is at the level. It is not the entry. The entry needs
  a 4H rejection candle, or a 4H close back on the plan side of the level.
- **close:** only a daily close past the level counts. Every invalidation is this kind.
- **break:** a 4H close past the level, with a volume ratio of 1.5 or more.
- **touch:** the level itself is the event: a target, or an at-market entry.

## Procedure

1. Read `status`. Do not change it. Do not make a different status from the bars.
2. For an `invalidation` alert, the side is "no trade". Say which plan it cancels when the
   daily close confirms it. Do not call it an entry in the other direction.
3. For a `target` alert, tell the management rule: take half off, and move the stop to the entry.
4. Tell what happened: a close through the level, or only a wick. Give the volume ratio.
5. Compare `analysis` with `now`. Tell each new structure event, news item, or earnings change.
   When nothing changed, say so in one sentence.
6. When `age.sinceAnalysis` is more than 10 sessions, tell the user that the plan is old,
   and that the new facts decide.
7. When earnings are 10 sessions away or less, give the date and the size of 0.5%.

## Output format

Start with these four lines. Use the same words every time.

```
**Side:** Short — the short retest plan.
**Why:** Retest of the 14 Oct bearish BOS level (771.39), now the nearest supply.
**Status:** Waiting. The alert is the tag, not the entry. It needs a 4H close back below 771.39.
**Stop:** 782.00 (the level + 0.5 × ATR 4H). Invalidation: a daily close above 771.39.
```

Then, in short sections:

- **What happened** — two or three sentences.
- **What changed** — a short list, or "Nothing changed since the analysis."
- **Next step** — one instruction: wait for X, enter at X, take half off, move the stop, or cancel.
- **Targets** — T1 and T2 with R:R from the worse entry. When the plan has no target,
  write "No fixed target. Trail the stop." and give the risk per share.

Do not write a chart-marks block. Do not give a number that is not in the input.
