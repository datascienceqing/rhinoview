import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { savedPlan, statusOf, triggerKindOf } from './explain';
import type { StatusInput } from './explain';
import type { Facts } from './facts/build';
import type { Plan } from './facts/plans';

const H = 3600;
// Mon 2026-10-26, 13:30 UTC (09:30 New York): the first 4H bar of the day.
const OPEN = Date.UTC(2026, 9, 26, 13, 30) / 1000;
const DAY = (n: number) => Date.UTC(2026, 9, 26 + n) / 1000;

const bar = (time: number, close: number, o: Partial<Bar> = {}): Bar => ({
  time, open: close, high: close, low: close, close, volume: 100, vwap: null, trades: null, ...o,
}) as Bar;

/** A short retest of 100: stop 103, invalidation 101. */
const shortRetest: Plan = {
  kind: 'retest', side: 'short', entryType: 'limit', entryLow: 100, entryHigh: 101, rrEntry: 100, trigger: 't',
  invalidation: { price: 101, label: 'BOS level' }, stop: 103, stopPct: 3,
  stopRule: { invalidation: 101, atrMult: 0.5, atrLower: 4 },
  targets: [{ price: 90, label: 'OB', pct: -10, rr: 3.3 }], sizePct: 1, sizeReason: null, meetsTwoToOne: true,
};

/** 25 quiet 4H bars before the fire, so the volume ratio has its 20-bar average. */
const history = Array.from({ length: 25 }, (_, i) => bar(OPEN - (25 - i) * 4 * H, 97));

function input(over: Partial<StatusInput>): StatusInput {
  return { role: 'entry', plan: shortRetest, level: 100, firedAt: OPEN + H, now: OPEN + 3 * 24 * H, bars4h: [], bars1d: [], ...over };
}

describe('triggerKindOf', () => {
  it('maps the role and the plan to the trigger kind', () => {
    expect(triggerKindOf('entry', shortRetest)).toBe('tag');
    expect(triggerKindOf('entry', { kind: 'continuation', entryType: 'stop' })).toBe('break');
    expect(triggerKindOf('invalidation', shortRetest)).toBe('close');
    expect(triggerKindOf('target', shortRetest)).toBe('touch');
  });
});

describe('statusOf: tag', () => {
  it('is triggered by the first 4H close back below the level', () => {
    const r = statusOf(input({ bars4h: [...history, bar(OPEN, 100.5, { high: 101 }), bar(OPEN + 4 * H, 99.4)] }));
    expect(r).toMatchObject({ kind: 'tag', status: 'triggered', at: '2026-10-26' });
    expect(r.reason).toContain('closed at 99.4');
  });

  it('waits while no 4H bar closed back below, and the open bar does not count', () => {
    const r = statusOf(input({ now: OPEN + 2 * H, bars4h: [...history, bar(OPEN, 99, { high: 100.5 })] }));
    expect(r.status).toBe('waiting');
    expect(r.needs).toBe('A 4H close back below 100, or a 4H rejection candle.');
  });

  it('fails when price reaches the stop first', () => {
    const r = statusOf(input({ bars4h: [...history, bar(OPEN, 102, { high: 103.2 }), bar(OPEN + 4 * H, 99)] }));
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('stop level 103');
  });
});

describe('statusOf: close', () => {
  const inv = (bars1d: Bar[], now = DAY(3)) => statusOf(input({ role: 'invalidation', level: 101, bars1d, now }));

  it('is triggered by a daily close past the level', () => {
    expect(inv([bar(DAY(0), 101.5)]).status).toBe('triggered');
  });

  it('is only a wick when the daily close came back', () => {
    const r = inv([bar(DAY(0), 100.8, { high: 101.6 })]);
    expect(r.status).toBe('wick');
    expect(r.reason).toContain('The plan stays valid.');
  });

  it('waits for the daily close during the session', () => {
    expect(inv([bar(DAY(0), 101.5)], OPEN + 2 * H).status).toBe('waiting');
  });
});

describe('statusOf: break and touch', () => {
  const cont: Plan = { ...shortRetest, kind: 'continuation', entryType: 'stop', entryLow: 95, entryHigh: 95, invalidation: { price: 95, label: 'x' } };

  it('needs volume for a break', () => {
    const weak = statusOf(input({ plan: cont, level: 95, bars4h: [...history, bar(OPEN, 94.5)] }));
    expect(weak.status).toBe('waiting');
    expect(weak.reason).toContain('volume ratio is only 1');
    const strong = statusOf(input({ plan: cont, level: 95, bars4h: [...history, bar(OPEN, 94.5, { volume: 200 })] }));
    expect(strong.status).toBe('triggered');
    expect(strong.reason).toContain('volume ratio of 2');
  });

  it('a target is the event itself', () => {
    expect(statusOf(input({ role: 'target', level: 90 }))).toMatchObject({ kind: 'touch', status: 'triggered' });
  });
});

describe('savedPlan', () => {
  it('finds the featured plan by its marks, not only by its name', () => {
    const other = { ...shortRetest, stop: 104 };
    const saved = { plans: [other, shortRetest], marks: { lines: [{ price: 101, label: 'short retest entry', role: 'trigger' }, { price: 103, label: 'short retest stop', role: 'stop' }], zones: [] } } as unknown as Facts;
    expect(savedPlan(saved, 'short retest')).toBe(shortRetest);
    expect(savedPlan(saved, 'long retest')).toBeNull();
  });
});
