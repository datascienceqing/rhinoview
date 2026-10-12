import { ALERT_EXPIRY_CHOICES } from '@shared/types';
import { computeExpiresAt, isAlertExpiry } from './expiry';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('computeExpiresAt', () => {
  const start = at('2026-10-11T15:30:00Z');

  it('adds whole weeks', () => {
    expect(computeExpiresAt(start, '1w')).toBe(at('2026-10-18T15:30:00Z'));
    expect(computeExpiresAt(start, '2w')).toBe(at('2026-10-25T15:30:00Z'));
    expect(computeExpiresAt(start, '3w')).toBe(at('2026-11-01T15:30:00Z'));
  });

  it('adds calendar months and years in UTC and keeps the time of day', () => {
    expect(computeExpiresAt(start, '1M')).toBe(at('2026-11-11T15:30:00Z'));
    expect(computeExpiresAt(start, '2M')).toBe(at('2026-12-11T15:30:00Z'));
    expect(computeExpiresAt(start, '3M')).toBe(at('2027-01-11T15:30:00Z'));
    expect(computeExpiresAt(start, '1y')).toBe(at('2027-10-11T15:30:00Z'));
    expect(computeExpiresAt(start, '3y')).toBe(at('2029-10-11T15:30:00Z'));
  });

  it('clamps the day to the end of a shorter month', () => {
    expect(computeExpiresAt(at('2027-01-31T00:00:00Z'), '1M')).toBe(at('2027-02-28T00:00:00Z'));
    expect(computeExpiresAt(at('2028-01-31T00:00:00Z'), '1M')).toBe(at('2028-02-29T00:00:00Z'));
    expect(computeExpiresAt(at('2028-02-29T12:00:00Z'), '1y')).toBe(at('2029-02-28T12:00:00Z'));
    expect(computeExpiresAt(at('2026-08-31T00:00:00Z'), '1M')).toBe(at('2026-09-30T00:00:00Z'));
  });

  it('gives a later time for each longer choice', () => {
    const times = ALERT_EXPIRY_CHOICES.map((c) => computeExpiresAt(start, c));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1] as number);
  });
});

describe('isAlertExpiry', () => {
  it('accepts the nine choices only', () => {
    for (const c of ALERT_EXPIRY_CHOICES) expect(isAlertExpiry(c)).toBe(true);
    for (const c of ['1d', '4w', '1m', '', 1, null]) expect(isAlertExpiry(c)).toBe(false);
  });
});
