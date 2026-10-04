import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { snapMarkers } from './markers';
import type { ChartMarker } from './markers';

const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0, vwap: null, transactions: null });
// 2026-09-28 is a Monday. NY midnight (EDT) = 04:00 UTC.
const MON = Date.UTC(2026, 8, 28, 4) / 1000;
const DAY = 86_400;
const earnings = (time: number): ChartMarker => ({ id: `e${time}`, time, text: 'E' });

describe('snapMarkers', () => {
  it('daily bars: a marker lands on the bar of its date', () => {
    const bars = [0, 1, 2, 3, 4].map((d) => bar(MON + d * DAY));
    expect(snapMarkers(bars, [earnings(MON + 2 * DAY)]).map((m) => m.barTime)).toEqual([MON + 2 * DAY]);
  });

  it('weekly bars: a Wednesday marker lands on that week’s Monday bar, not the next week', () => {
    const bars = [bar(MON - 7 * DAY), bar(MON), bar(MON + 7 * DAY)];
    expect(snapMarkers(bars, [earnings(MON + 2 * DAY)]).map((m) => m.barTime)).toEqual([MON]);
  });

  it('intraday bars: a marker lands on the last bar of that session, not the previous day', () => {
    const open = MON + 9.5 * 3600; // 09:30 ET
    const bars = [-1, 0].flatMap((d) => [0, 1, 2].map((i) => bar(open + d * DAY + i * 3600)));
    const lastOfMonday = open + 2 * 3600;
    expect(snapMarkers(bars, [earnings(MON)]).map((m) => m.barTime)).toEqual([lastOfMonday]);
  });

  it('drops markers before the loaded history and upcoming markers after the last bar', () => {
    const bars = [bar(MON), bar(MON + DAY)];
    expect(snapMarkers(bars, [earnings(MON - 10 * DAY), earnings(MON + 30 * DAY)])).toEqual([]);
  });

  it('returns nothing for no bars, and sorts the output by bar time', () => {
    expect(snapMarkers([], [earnings(MON)])).toEqual([]);
    const bars = [0, 1, 2].map((d) => bar(MON + d * DAY));
    const out = snapMarkers(bars, [earnings(MON + 2 * DAY), earnings(MON)]);
    expect(out.map((m) => m.barTime)).toEqual([MON, MON + 2 * DAY]);
  });
});
