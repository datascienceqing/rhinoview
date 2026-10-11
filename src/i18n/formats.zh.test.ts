import type { Time } from 'lightweight-charts';
import { formatCrosshairTime, formatTick } from '../chart/timeFormat';
import { fiscalLabel, formatLarge, marginCell, multipleCell } from '../fundamentals/format';
import { ZH_LINE_KEYS, lineLabel } from '../fundamentals/lineLabels';
import { describeError } from '../ui/errorCopy';
import { formatVolume } from '../ui/format';
import { DataError } from '../data/errors';
import { applyLocale } from './locale';

// 2026-06-11 04:00 UTC: a daily bar (00:00 New York).
const DAY = (Date.UTC(2026, 5, 11, 4) / 1000) as Time;
const TICK = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3 };

describe('Chinese formats', () => {
  beforeEach(() => applyLocale('zh'));

  it('amounts use 万, 亿 and 万亿', () => {
    expect(formatLarge(394_330_000_000)).toBe('3,943.30亿');
    expect(formatLarge(1_270_000_000_000)).toBe('1.27万亿');
    expect(formatLarge(12_500_000)).toBe('1,250.00万');
    expect(formatLarge(-25_000)).toBe('-2.50万');
    expect(formatLarge(9_999)).toBe('9,999');
    expect(formatVolume(68_110_000)).toBe('6811万');
  });

  it('fiscal labels read 2026财年 and 2026财年Q1', () => {
    expect(fiscalLabel({ fiscalYear: 2026, fiscalPeriod: 'FY' })).toBe('2026财年');
    expect(fiscalLabel({ fiscalYear: 2026, fiscalPeriod: 'Q1' })).toBe('2026财年Q1');
  });

  it('NM is 无意义, with a Chinese reason', () => {
    expect(multipleCell(-5.54)).toEqual({ text: '无意义', title: '无意义：盈利为负' });
    expect(marginCell(0.6, true).text).toBe('无意义');
  });

  it('statement lines have Chinese names by key, and unknown keys keep the server label', () => {
    expect(lineLabel('revenue', 'Revenue')).toBe('营业收入');
    expect(lineLabel('freeCashFlow', 'Free cash flow')).toBe('自由现金流');
    expect(lineLabel('somethingNew', 'Something new')).toBe('Something new');
    expect(ZH_LINE_KEYS.length).toBeGreaterThanOrEqual(40);
  });

  it('daily axis ticks and the crosshair date are Chinese, in UTC', () => {
    expect(formatTick(DAY, TICK.Year, false)).toBe('2026年');
    expect(formatTick(DAY, TICK.Month, false)).toBe('6月');
    expect(formatTick(DAY, TICK.DayOfMonth, false)).toBe('11日');
    expect(formatCrosshairTime(DAY, false)).toBe('2026年6月11日');
  });

  it('error copy is Chinese, with the wait time', () => {
    const copy = describeError(new DataError('RATE_LIMITED', 'x', { retryAfterSeconds: 12 }), 'chart');
    expect(copy.title).toBe('请求过多');
    expect(copy.detail).toContain('12 秒');
    expect(describeError(new DataError('NETWORK', 'x'), 'quote').detail).toContain('报价');
  });
});

describe('English formats stay as they were', () => {
  beforeEach(() => applyLocale('en'));

  it('amounts, fiscal labels and ticks', () => {
    expect(formatLarge(394_330_000_000)).toBe('394.33B');
    expect(fiscalLabel({ fiscalYear: 2026, fiscalPeriod: 'Q1' })).toBe('Q1 FY2026');
    expect(formatTick(DAY, TICK.Month, false)).toBeNull(); // the library default
    expect(formatCrosshairTime(DAY, false)).toBe('Jun 11, 2026');
    expect(lineLabel('revenue', 'Revenue')).toBe('Revenue');
  });
});
