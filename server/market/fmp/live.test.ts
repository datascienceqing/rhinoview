/**
 * LIVE integration test against the real FMP API. SKIPPED unless FMP_LIVE=1, so CI stays
 * hermetic and never spends the plan's request budget. Written for FMP Starter: 5min,
 * 15min and 1hour intraday are served; 1min is HTTP 402, so the engine refuses it locally.
 * 4h is folded from the 1hour rows, so it exercises the same request.
 *
 *   FMP_LIVE=1 npx vitest run --project node server/market/fmp/live
 *
 * Needs FMP_API_KEY in `.env`. This file reads it straight from the environment because
 * the engine takes the key as a constructor argument; `server/env.ts` (frozen) does not
 * expose it. Costs about nine requests per run.
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@shared/types';
import { mapEngineError } from '../../provider/errors';
import { nyDayOf, sessionMinutes, sessionOpenUnix } from '../calendar';
import { createFmpEngine } from './index';

const live = process.env.FMP_LIVE === '1' && Boolean(process.env.FMP_API_KEY);
const DAY = 86_400;

describe.skipIf(!live)('FMP live (FMP_LIVE=1)', () => {
  const engine = createFmpEngine({ apiKey: process.env.FMP_API_KEY ?? 'unused' });
  const now = Math.floor(Date.now() / 1000);

  it('resolves a symbol case-insensitively and rejects an unknown one', async () => {
    expect(await engine.resolveSymbol('aapl')).toMatchObject({ symbol: 'AAPL' });
    expect(await engine.resolveSymbol('ZZZZNOPE')).toBeUndefined();
  });

  it('searches', async () => {
    const out = await engine.searchSymbols('apple', 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((r) => r.symbol)).toContain('AAPL');
  });

  it('serves 1D bars ascending, and 1W bars that are exact aggregates of those days', async () => {
    const from = now - 60 * DAY;
    const daily = (await engine.getBars({ symbol: 'AAPL', timeframe: '1D', from, to: now, adjusted: true, limit: 2000 })).bars;
    const weekly = (await engine.getBars({ symbol: 'AAPL', timeframe: '1W', from, to: now, adjusted: true, limit: 400 })).bars;
    expect(daily.length).toBeGreaterThan(20);
    for (let i = 1; i < daily.length; i++) expect(daily[i]?.time).toBeGreaterThan(daily[i - 1]?.time ?? Infinity);
    expect(weekly.length).toBeGreaterThan(5);

    // Pick a whole, completed week in the middle and redo the arithmetic from the days.
    const week = weekly[Math.floor(weekly.length / 2)];
    if (!week) throw new Error('no weekly bar');
    const days = daily.filter((d) => d.time >= week.time && d.time < week.time + 7 * DAY);
    const sum = days.reduce((s, d) => s + d.volume, 0);
    console.info(
      `1W ${new Date(week.time * 1000).toISOString()} volume=${week.volume}; days: ${days.map((d) => d.volume).join(' + ')} = ${sum}`,
    );
    expect(week.volume).toBe(sum);
    expect(week.open).toBe(days[0]?.open);
    expect(week.close).toBe(days.at(-1)?.close);
    expect(week.high).toBe(Math.max(...days.map((d) => d.high)));
    expect(week.low).toBe(Math.min(...days.map((d) => d.low)));
  });

  it('snapshot changePercent is a fraction that agrees with change / previousClose', async () => {
    const snap = await engine.getSnapshot('AAPL', now);
    console.info(`snapshot AAPL price=${snap.price} change=${snap.change} changePercent=${snap.changePercent} delayed=${snap.delayed}`);
    expect(snap.price).toBeGreaterThan(0);
    expect(snap.delayed).toBe(true);
    expect(Math.abs((snap.changePercent ?? 0) - (snap.change ?? 0) / (snap.previousClose ?? 1))).toBeLessThan(1e-3);
  });

  it('1m is refused locally as UNAUTHORIZED: Starter answers 402, so it is not requested', async () => {
    const err = await engine.getBars({ symbol: 'AAPL', timeframe: '1m', from: now - DAY, to: now, adjusted: true, limit: 10 }).catch((e: unknown) => e);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });

  const SPAN: Partial<Record<Timeframe, number>> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400 };
  for (const timeframe of ['5m', '15m', '1h', '4h'] as const) {
    it(`serves ${timeframe} bars: ascending, in the regular session, on the bar grid, whole-share volume`, async () => {
      // A week back always holds at least one session, even across a long holiday weekend.
      const from = now - 7 * DAY;
      const { bars } = await engine.getBars({ symbol: 'AAPL', timeframe, from, to: now, adjusted: true, limit: 5000 });
      const span = SPAN[timeframe] ?? NaN;
      const newest = bars.at(-1);
      console.info(`${timeframe} AAPL bars=${bars.length} oldest=${bars[0] ? new Date(bars[0].time * 1000).toISOString() : '-'} newest=${newest ? new Date(newest.time * 1000).toISOString() : '-'}`);
      expect(bars.length).toBeGreaterThan(0);
      for (let i = 1; i < bars.length; i++) expect(bars[i]?.time).toBeGreaterThan(bars[i - 1]?.time ?? Infinity);
      for (const b of bars) {
        expect(b.time).toBeGreaterThanOrEqual(from);
        expect(b.time).toBeLessThanOrEqual(now);
        // Bar times are NY wall-clock bar OPENS: inside the session, a whole number of spans after 09:30.
        const day = nyDayOf(b.time);
        const sinceOpen = b.time - sessionOpenUnix(day);
        expect(sessionMinutes(day)).toBeGreaterThan(0);
        expect(sinceOpen).toBeGreaterThanOrEqual(0);
        expect(sinceOpen).toBeLessThan(sessionMinutes(day) * 60);
        expect(sinceOpen % span).toBe(0);
        expect(Number.isInteger(b.volume)).toBe(true);
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      }
      // The newest bar is recent: no more than 4 calendar days old (a long weekend), so the
      // data is current, not a stale archive.
      expect(now - (newest?.time ?? 0)).toBeLessThan(4 * DAY + span);
    });
  }
});
