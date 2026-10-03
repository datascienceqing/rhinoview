/**
 * LIVE integration test against the real FMP API. SKIPPED unless FMP_LIVE=1, so CI stays
 * hermetic and never spends the free-tier budget.
 *
 *   FMP_LIVE=1 npx vitest run --project node server/market/fmp/live
 *
 * Needs FMP_API_KEY in `.env`. This file reads it straight from the environment because
 * the engine takes the key as a constructor argument; `server/env.ts` (frozen) does not
 * expose it. Costs about six requests per run.
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { mapEngineError } from '../../provider/errors';
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

  it('intraday is refused locally as UNAUTHORIZED and the paid tier is not probed', async () => {
    const err = await engine.getBars({ symbol: 'AAPL', timeframe: '5m', from: now - DAY, to: now, adjusted: true, limit: 10 }).catch((e: unknown) => e);
    expect(mapEngineError(err).code).toBe('UNAUTHORIZED');
  });
});
