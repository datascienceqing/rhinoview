"""Backtest of trade management rules for the trade-check skill.

Same retest trades as run.py, with the stop at the level + 0.33 x ATR(1D) (about 0.5 x ATR 4H).
Each variant manages the same entries in a different way. Rules on one bar, in this order:
  1. The stop (a gap through the stop exits at the open).
  2. T1, then T2.
  3. After the bar: move the stop to the entry if the bar reached +1R; trail the stop after T1.
A trail is the high (low) of the last 3 daily bars. Daily bars stand in for the 4H swings.

Run: python3 scripts/backtest/manage.py
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import run

STOP_BUFFER = 0.33
TRAIL_BARS = 3

VARIANTS = {
    'A  all at T1': dict(frac_t1=1.0, be_at_1r=False, trail=False),
    'B  all at T2': dict(frac_t1=0.0, be_at_1r=False, trail=False),
    'C  skill default (1/3 T1, BE at +1R, trail)': dict(frac_t1=1 / 3, be_at_1r=True, trail=True),
    'D  1/3 T1, trail, no BE': dict(frac_t1=1 / 3, be_at_1r=False, trail=True),
    'E  1/3 T1, BE at +1R, no trail': dict(frac_t1=1 / 3, be_at_1r=True, trail=False),
    'F  1/2 T1, BE at +1R, trail': dict(frac_t1=0.5, be_at_1r=True, trail=True),
}


def manage(ev: dict, frac_t1: float, be_at_1r: bool, trail: bool) -> float | None:
    tr = ev['trade']
    if tr is None:
        return None
    h, l, c, n = ev['_arrays']
    o = ev['_open']
    side, level, fill, t1, t2 = ev['side'], ev['level'], tr['fill'], tr['target'], tr['target2']
    sign = 1 if side == 'long' else -1
    stop = level - sign * STOP_BUFFER * tr['atr']
    risk = sign * (fill - stop)
    if risk <= 0 or sign * (t1 - fill) <= 0 or sign * (t2 - t1) <= 0:
        return None

    left, result, t1_done = 1.0, 0.0, False
    r0 = tr['r']
    end = min(r0 + run.MAX_HOLD, n)
    for i in range(r0, end):
        hi, lo = h[i], l[i]
        if (lo <= stop) if side == 'long' else (hi >= stop):
            px = stop
            if i > r0 and ((o[i] < stop) if side == 'long' else (o[i] > stop)):
                px = o[i]
            return result + left * sign * (px - fill) / risk
        reach = (lambda x: hi >= x) if side == 'long' else (lambda x: lo <= x)
        if not t1_done and reach(t1):
            take = left if frac_t1 >= 1 else frac_t1
            result += take * sign * (t1 - fill) / risk
            left -= take
            t1_done = True
            if left <= 1e-9:
                return result
        if reach(t2):
            return result + left * sign * (t2 - fill) / risk
        if be_at_1r and reach(fill + sign * risk):
            stop = max(stop, fill) if side == 'long' else min(stop, fill)
        if trail and t1_done:
            lo_i = max(r0, i - TRAIL_BARS + 1)
            if side == 'long':
                stop = max(stop, l[lo_i:i + 1].min())
            else:
                stop = min(stop, h[lo_i:i + 1].max())
    return result + left * sign * (c[end - 1] - fill) / risk


def main() -> None:
    evs = []
    for path in sorted(run.DATA.glob('*.json')):
        evs += run.events(run.load(path))

    rows = {name: [manage(e, **cfg) for e in evs] for name, cfg in VARIANTS.items()}
    res = pd.DataFrame(rows)
    res['date'] = [e['date'] for e in evs]
    res['rr_t2'] = [
        (abs(e['trade']['target2'] - e['trade']['fill'])
         / abs(e['trade']['fill'] - (e['level'] - (1 if e['side'] == 'long' else -1) * STOP_BUFFER * e['trade']['atr'])))
        if e['trade'] is not None else np.nan
        for e in evs
    ]
    res['aligned'] = [e['ema_aligned'] for e in evs]
    res = res.dropna(subset=list(VARIANTS))
    print(f'Trades with T1 and T2: {len(res)}')

    groups = {
        'all trades': res,
        'skill would take (R:R to T2 >= 2, with EMA200 trend)': res[(res.rr_t2 >= 2) & res.aligned],
        '2008-2017, skill would take': res[(res.rr_t2 >= 2) & res.aligned & (res.date < run.SPLIT_DATE)],
        '2017-2026, skill would take': res[(res.rr_t2 >= 2) & res.aligned & (res.date >= run.SPLIT_DATE)],
    }
    for title, part in groups.items():
        out = [{'variant': name, **run.summary(part[name].astype(float).to_numpy())} for name in VARIANTS]
        run.table(out, f'{title} ({len(part)} trades)')

    # Paired difference: the skill default against each other variant, on the same trades.
    part = groups['skill would take (R:R to T2 >= 2, with EMA200 trend)']
    base = 'C  skill default (1/3 T1, BE at +1R, trail)'
    out = []
    for name in VARIANTS:
        if name == base:
            continue
        d = (part[name] - part[base]).astype(float).to_numpy()
        boot = run.RNG.choice(d, size=(2000, len(d))).mean(axis=1)
        out.append({'variant minus default': name, 'avg dR': d.mean(),
                    'ci_lo': np.percentile(boot, 2.5), 'ci_hi': np.percentile(boot, 97.5)})
    run.table(out, 'Paired difference against the skill default (trades the skill would take)')


if __name__ == '__main__':
    main()
