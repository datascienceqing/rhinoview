"""Backtests for three open rules of the trade-check skill (server/ai/skills/trade-check.md).

1. Stop buffer: stop at the broken level itself, or level + k x ATR.
2. Long MA filter: EMA200 or SMA200.
3. Volume average length: 20, 25, 30, or 35 bars.

The test setup is the skill's "retest plan" on daily bars:
  - A swing low (high) is a pivot with 5 bars on each side, confirmed 5 bars later.
  - A bearish (bullish) BOS is the first close below (above) the latest confirmed swing low (high).
  - Within 20 bars, price comes back to the broken level. A limit order fills 0.1 x ATR before the level.
  - T1 is the extreme between the BOS and the retest. The stop is the level + k x ATR.
  - When one bar touches the stop and the target, the trade counts as a loss.
  - A gap through the stop exits at the open, not at the stop.
  - A trade that reaches neither in 40 bars exits at the close.

Run: python3 scripts/backtest/run.py   (after scripts/backtest/fetch.py)
"""
from __future__ import annotations

import json
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / 'data' / 'backtest'

PIVOT = 5
RETEST_WINDOW = 20
MAX_HOLD = 40
ENTRY_OFFSET_ATR = 0.1
BUFFERS = [0.0, 0.1, 0.2, 0.33, 0.5, 0.75, 1.0]
VOLUME_LENGTHS = [20, 25, 30, 35]
SPLIT_DATE = '2017-07-01'
RNG = np.random.default_rng(7)


def load(path: pathlib.Path) -> pd.DataFrame:
    df = pd.DataFrame(json.loads(path.read_text()))[['date', 'open', 'high', 'low', 'close', 'volume']]
    df = df.drop_duplicates('date').sort_values('date').reset_index(drop=True)
    return df[(df['high'] > 0) & (df['low'] > 0)].reset_index(drop=True)


def wilder_atr(df: pd.DataFrame, period: int = 14) -> np.ndarray:
    prev = df['close'].shift(1)
    tr = pd.concat([df['high'] - df['low'], (df['high'] - prev).abs(), (df['low'] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean().to_numpy()


def events(df: pd.DataFrame) -> list[dict]:
    """BOS events with the retest trade geometry, before any stop choice."""
    o, h, l, c, v = (df[k].to_numpy(float) for k in ('open', 'high', 'low', 'close', 'volume'))
    n = len(df)
    atr = wilder_atr(df)
    ema200 = df['close'].ewm(span=200, adjust=False, min_periods=200).mean().to_numpy()
    sma200 = df['close'].rolling(200).mean().to_numpy()
    vol_avg = {m: pd.Series(v).shift(1).rolling(m).mean().to_numpy() for m in VOLUME_LENGTHS}

    out = []
    last_low = last_high = None  # (level, used)
    lows: list[float] = []  # Every confirmed swing low, oldest first. T2 comes from these.
    highs: list[float] = []
    for t in range(PIVOT * 2 + 1, n):
        # A pivot at t - PIVOT is confirmed at t.
        p = t - PIVOT
        win_l, win_h = l[p - PIVOT:p + PIVOT + 1], h[p - PIVOT:p + PIVOT + 1]
        if l[p] < l[p - PIVOT:p].min() and l[p] <= win_l[PIVOT + 1:].min():
            last_low = [l[p], False]
            lows.append(l[p])
        if h[p] > h[p - PIVOT:p].max() and h[p] >= win_h[PIVOT + 1:].max():
            last_high = [h[p], False]
            highs.append(h[p])
        if t < 220 or np.isnan(atr[t]):
            continue
        for side, piv in (('short', last_low), ('long', last_high)):
            if piv is None or piv[1]:
                continue
            level = piv[0]
            broke = c[t] < level <= c[t - 1] if side == 'short' else c[t] > level >= c[t - 1]
            if not broke:
                continue
            piv[1] = True
            sign = 1 if side == 'long' else -1
            ev = {
                'date': df['date'].iat[t], 'side': side, 'level': level, 'atr': atr[t],
                'ema_aligned': sign * (c[t] - ema200[t]) > 0, 'sma_aligned': sign * (c[t] - sma200[t]) > 0,
                # Follow-through: 10-bar move in the break direction, in ATR.
                'fwd10': sign * (c[min(t + 10, n - 1)] - c[t]) / atr[t] if t + 10 < n else np.nan,
            }
            for m in VOLUME_LENGTHS:
                ev[f'vr{m}'] = v[t] / vol_avg[m][t] if vol_avg[m][t] > 0 else np.nan
            # Retest: the first bar that reaches the entry price.
            entry = level + sign * ENTRY_OFFSET_ATR * atr[t]
            extreme = l[t] if side == 'short' else h[t]
            ev['trade'] = None
            for r in range(t + 1, min(t + 1 + RETEST_WINDOW, n)):
                reached = h[r] >= entry if side == 'short' else l[r] <= entry
                if reached:
                    fill = max(entry, o[r]) if side == 'short' else min(entry, o[r])
                    ev['trade'] = {'r': r, 'fill': fill, 'target': extreme, 'atr': atr[r - 1],
                                   'target2': second_target(side, fill, extreme, lows, highs)}
                    break
                extreme = min(extreme, l[r]) if side == 'short' else max(extreme, h[r])
            ev['_arrays'] = (h, l, c, n)
            ev['_open'] = o
            out.append(ev)
    return out


def second_target(side: str, fill: float, t1: float, lows: list[float], highs: list[float]) -> float:
    """T2: the nearest older swing beyond T1 in the last 30 swings, else a measured move (T1 + the entry-to-T1 distance)."""
    if side == 'short':
        beyond = [x for x in lows[-30:] if x < t1]
        return max(beyond) if beyond else t1 - (fill - t1)
    beyond = [x for x in highs[-30:] if x > t1]
    return min(beyond) if beyond else t1 + (t1 - fill)


def simulate(ev: dict, k: float) -> float | None:
    """Result of the retest trade in R, or None if there is no valid trade."""
    tr = ev['trade']
    if tr is None:
        return None
    h, l, c, n = ev['_arrays']
    o = ev['_open']
    side, level, fill, target = ev['side'], ev['level'], tr['fill'], tr['target']
    sign = 1 if side == 'long' else -1
    stop = level - sign * k * tr['atr']
    risk = sign * (fill - stop)
    if risk <= 0 or sign * (target - fill) <= 0:
        return None  # The bar opened past the stop, or no room to the target.
    r0 = tr['r']
    for i in range(r0, min(r0 + MAX_HOLD, n)):
        hit_stop = l[i] <= stop if side == 'long' else h[i] >= stop
        hit_target = h[i] >= target if side == 'long' else l[i] <= target
        if hit_stop:
            # A gap through the stop fills at the open, which is worse than -1R.
            gapped = i > r0 and (o[i] < stop if side == 'long' else o[i] > stop)
            return sign * (o[i] - fill) / risk if gapped else -1.0
        if hit_target:
            return sign * (target - fill) / risk
    last = min(r0 + MAX_HOLD, n) - 1
    return sign * (c[last] - fill) / risk


def summary(rs: np.ndarray) -> dict:
    rs = rs[~np.isnan(rs)]
    if len(rs) == 0:
        return {'n': 0}
    boot = RNG.choice(rs, size=(2000, len(rs))).mean(axis=1)
    wins, losses = rs[rs > 0].sum(), -rs[rs < 0].sum()
    return {
        'n': len(rs), 'win%': 100 * (rs > 0).mean(), 'avgR': rs.mean(),
        'ci_lo': np.percentile(boot, 2.5), 'ci_hi': np.percentile(boot, 97.5),
        'medianR': np.median(rs), 'PF': wins / losses if losses else np.inf,
    }


def table(rows: list[dict], title: str) -> None:
    print(f'\n## {title}\n')
    print(pd.DataFrame(rows).to_string(index=False, float_format=lambda x: f'{x:.3f}'))


def main() -> None:
    evs = []
    for path in sorted(DATA.glob('*.json')):
        for ev in events(load(path)):
            ev['symbol'] = path.stem
            evs.append(ev)
    df = pd.DataFrame([{k: v for k, v in e.items() if not k.startswith('_') and k != 'trade'} for e in evs])
    df['has_trade'] = [e['trade'] is not None for e in evs]
    for k in BUFFERS:
        df[f'R_{k}'] = [simulate(e, k) for e in evs]
    df['late'] = df['date'] >= SPLIT_DATE
    print(f'Symbols: {df.symbol.nunique()}  BOS events: {len(df)}  with a retest: {df.has_trade.sum()}')

    # 1. Stop buffer.
    rows = []
    for k in BUFFERS:
        for label, part in (('all', df), ('2008-2017', df[~df.late]), ('2017-2026', df[df.late])):
            rows.append({'buffer_xATR1D': k, 'period': label, **summary(part[f'R_{k}'].astype(float).to_numpy())})
    table(rows, 'Test 1 - stop buffer (level + k x daily ATR). 0.5 x ATR(4H) is about 0.33 x ATR(1D).')

    # Same trades for every buffer, so the comparison is on one set of entries.
    common = df.dropna(subset=[f'R_{k}' for k in BUFFERS])
    rows = [{'buffer_xATR1D': k, **summary(common[f'R_{k}'].astype(float).to_numpy())} for k in BUFFERS]
    table(rows, f'Test 1b - stop buffer on the same {len(common)} trades')

    # 2. MA filter, with the stop rule of the skill (0.33 x ATR1D, about 0.5 x ATR4H).
    col = 'R_0.33'
    rows = []
    for label, mask in (
        ('no filter', df[col].notna() | df[col].isna()),
        ('with EMA200 trend', df.ema_aligned), ('against EMA200 trend', ~df.ema_aligned),
        ('with SMA200 trend', df.sma_aligned), ('against SMA200 trend', ~df.sma_aligned),
        ('EMA with, SMA against', df.ema_aligned & ~df.sma_aligned),
        ('SMA with, EMA against', df.sma_aligned & ~df.ema_aligned),
    ):
        part = df[mask]
        rows.append({'filter': label, 'fwd10_ATR': part.fwd10.mean(), **summary(part[col].astype(float).to_numpy())})
    table(rows, 'Test 2 - trend filter (trade R with stop 0.33 x ATR1D; fwd10 = 10-day follow-through of every BOS, in ATR)')
    agree = (df.ema_aligned == df.sma_aligned).mean()
    print(f'\nEMA200 and SMA200 give the same answer on {100 * agree:.1f}% of BOS events.')

    # 3. Volume average length.
    rows = []
    for m in VOLUME_LENGTHS:
        hi = df[f'vr{m}'] >= 1.5
        for label, part in (('all', df), ('2008-2017', df[~df.late]), ('2017-2026', df[df.late])):
            hp, lp = part[hi.loc[part.index]], part[~hi.loc[part.index]]
            rows.append({
                'length': m, 'period': label, 'n_high_vol': len(hp),
                'fwd10_high': hp.fwd10.mean(), 'fwd10_low': lp.fwd10.mean(),
                'lift_fwd10': hp.fwd10.mean() - lp.fwd10.mean(),
                'avgR_high': hp[col].astype(float).mean(), 'avgR_low': lp[col].astype(float).mean(),
            })
    table(rows, 'Test 3 - volume ratio >= 1.5x on the BOS bar, by average length')
    flags = pd.DataFrame({m: df[f'vr{m}'] >= 1.5 for m in VOLUME_LENGTHS})
    print('\nShare of BOS bars where two lengths give the same high/low volume answer:')
    print(pd.DataFrame({a: {b: (flags[a] == flags[b]).mean() for b in VOLUME_LENGTHS} for a in VOLUME_LENGTHS}).round(3).to_string())


if __name__ == '__main__':
    main()
