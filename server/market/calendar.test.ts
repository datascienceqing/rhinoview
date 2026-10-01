import { describe, expect, it } from 'vitest';
import {
  civilToDay,
  dayStartUnix,
  dayToCivil,
  isEarlyClose,
  isHoliday,
  isTradingDay,
  mondayOf,
  nyDayOf,
  nyOffsetSeconds,
  sessionMinutes,
  sessionOpenUnix,
  tradingSlot,
  weekdayOf,
} from './calendar';

const day = (y: number, m: number, d: number): number => civilToDay(y, m, d);
const utc = (y: number, m: number, d: number, h = 0, mi = 0): number => Date.UTC(y, m - 1, d, h, mi) / 1000;

describe('civil date arithmetic', () => {
  it('round-trips every day across 1970-2100', () => {
    for (let n = 0; n < 47_500; n += 7) {
      const { year, month, day: d } = dayToCivil(n);
      expect(civilToDay(year, month, d)).toBe(n);
    }
  });

  it('knows the weekday (1970-01-01 Thursday, 2025-01-15 Wednesday, 2026-07-04 Saturday)', () => {
    expect(weekdayOf(0)).toBe(3);
    expect(weekdayOf(day(2025, 1, 15))).toBe(2);
    expect(weekdayOf(day(2026, 7, 4))).toBe(5);
  });

  it('finds the Monday of a week, including from a Sunday', () => {
    expect(mondayOf(day(2025, 3, 12))).toBe(day(2025, 3, 10));
    expect(mondayOf(day(2025, 3, 9))).toBe(day(2025, 3, 3));
  });

  it('assigns consecutive trading slots to Friday and the following Monday', () => {
    expect(tradingSlot(day(2025, 3, 10))).toBe(tradingSlot(day(2025, 3, 7)) + 1);
  });
});

describe('invariant 3: US market holidays', () => {
  const closed2025 = [
    [1, 1],
    [1, 9], // national day of mourning (Carter)
    [1, 20],
    [2, 17],
    [4, 18],
    [5, 26],
    [6, 19],
    [7, 4],
    [9, 1],
    [11, 27],
    [12, 25],
  ] as const;

  it('closes on every 2025 holiday', () => {
    for (const [m, d] of closed2025) expect(sessionMinutes(day(2025, m, d)), `2025-${m}-${d}`).toBe(0);
  });

  it('has exactly the 250 trading days NYSE had in 2025', () => {
    let n = 0;
    for (let d = day(2025, 1, 1); d <= day(2025, 12, 31); d++) if (isTradingDay(d)) n++;
    expect(n).toBe(250);
  });

  it('computes Good Friday from Easter (2024-03-29, 2025-04-18, 2026-04-03, 2027-03-26)', () => {
    for (const [y, m, d] of [
      [2024, 3, 29],
      [2025, 4, 18],
      [2026, 4, 3],
      [2027, 3, 26],
    ] as const) {
      expect(isHoliday(day(y, m, d)), `${y}-${m}-${d}`).toBe(true);
    }
  });

  it('observes a Saturday holiday on Friday and a Sunday holiday on Monday', () => {
    expect(isHoliday(day(2026, 7, 3))).toBe(true); // 4 Jul 2026 is a Saturday
    expect(isHoliday(day(2027, 7, 5))).toBe(true); // 4 Jul 2027 is a Sunday
    expect(isHoliday(day(2022, 12, 26))).toBe(true); // Christmas on a Sunday
    expect(isHoliday(day(2023, 1, 2))).toBe(true); // New Year's on a Sunday
    expect(isHoliday(day(2027, 12, 24))).toBe(true); // Christmas on a Saturday
  });

  it('stays open on the Friday before a Saturday New Year', () => {
    expect(day(2022, 1, 1)).toSatisfy((d: number) => weekdayOf(d) === 5);
    expect(isTradingDay(day(2021, 12, 31))).toBe(true);
  });

  it('only observes Juneteenth from 2022', () => {
    expect(isTradingDay(day(2021, 6, 18))).toBe(true);
    expect(isHoliday(day(2022, 6, 20))).toBe(true);
    expect(isHoliday(day(2024, 6, 19))).toBe(true);
  });

  it('is closed on weekends', () => {
    expect(sessionMinutes(day(2025, 3, 8))).toBe(0);
    expect(sessionMinutes(day(2025, 3, 9))).toBe(0);
  });
});

describe('invariant 3: early 13:00 closes', () => {
  it('shortens the day after Thanksgiving, 24 Dec and 3 Jul to 210 minutes', () => {
    for (const [y, m, d] of [
      [2024, 11, 29],
      [2024, 12, 24],
      [2024, 7, 3],
      [2025, 7, 3],
      [2025, 11, 28],
      [2025, 12, 24],
      [2026, 11, 27],
      [2026, 12, 24],
    ] as const) {
      expect(sessionMinutes(day(y, m, d)), `${y}-${m}-${d}`).toBe(210);
      expect(isEarlyClose(day(y, m, d))).toBe(true);
    }
  });

  it('does not shorten a half-day that is itself a holiday or a weekend', () => {
    expect(sessionMinutes(day(2026, 7, 3))).toBe(0); // holiday (observed 4 Jul)
    expect(sessionMinutes(day(2027, 12, 24))).toBe(0); // holiday (observed 25 Dec)
    expect(isEarlyClose(day(2027, 12, 24))).toBe(false);
    expect(isEarlyClose(day(2028, 12, 24))).toBe(false); // a Sunday
  });

  it('leaves ordinary days at 390 minutes', () => {
    expect(sessionMinutes(day(2025, 3, 12))).toBe(390);
    expect(sessionMinutes(day(2025, 11, 26))).toBe(390); // day before Thanksgiving
  });
});

describe('invariant 3: New York wall clock, not a hardcoded offset', () => {
  // Expected instants are written as literal UTC so this does not lean on the code under test.
  it('opens at 09:30 New York in January (14:30Z) and in July (13:30Z)', () => {
    expect(sessionOpenUnix(day(2025, 1, 15))).toBe(utc(2025, 1, 15, 14, 30));
    expect(sessionOpenUnix(day(2025, 7, 16))).toBe(utc(2025, 7, 16, 13, 30));
  });

  it('stamps a 1D bar at 00:00 New York (05:00Z in winter, 04:00Z in summer)', () => {
    expect(dayStartUnix(day(2025, 1, 15))).toBe(utc(2025, 1, 15, 5));
    expect(dayStartUnix(day(2025, 7, 16))).toBe(utc(2025, 7, 16, 4));
  });

  it('switches offset across spring-forward (9 Mar 2025) and fall-back (2 Nov 2025)', () => {
    expect(sessionOpenUnix(day(2025, 3, 7))).toBe(utc(2025, 3, 7, 14, 30)); // Fri, EST
    expect(sessionOpenUnix(day(2025, 3, 10))).toBe(utc(2025, 3, 10, 13, 30)); // Mon, EDT
    expect(sessionOpenUnix(day(2025, 10, 31))).toBe(utc(2025, 10, 31, 13, 30)); // Fri, EDT
    expect(sessionOpenUnix(day(2025, 11, 3))).toBe(utc(2025, 11, 3, 14, 30)); // Mon, EST
    expect(dayStartUnix(day(2025, 3, 10))).toBe(utc(2025, 3, 10, 4)); // Monday midnight after the change
  });

  it('reports the offset Intl reports', () => {
    expect(nyOffsetSeconds(utc(2025, 1, 15, 12))).toBe(-5 * 3600);
    expect(nyOffsetSeconds(utc(2025, 7, 15, 12))).toBe(-4 * 3600);
  });

  it('maps an instant to the New York civil date, not the UTC date', () => {
    // 02:00Z on 16 Jul is still the evening of 15 Jul in New York.
    expect(nyDayOf(utc(2025, 7, 16, 2))).toBe(day(2025, 7, 15));
    expect(nyDayOf(utc(2025, 7, 16, 5))).toBe(day(2025, 7, 16));
  });
});
