/**
 * INTEGRATION test against A1's real synthetic engine (the only test here that uses it):
 * the header (`/api/snapshot`) and the chart's newest bar sit side by side, so mid-session
 * they must agree. Neither engine.test.ts nor the fake-engine tests can see this.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiResult, BarsResponse, Snapshot, Timeframe } from '@shared/types';
import { buildServer } from '../index';
import { createSyntheticEngine } from '../market';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

// Wed 2026-09-30, 10:00:30 EDT (UTC-4) — 30 s into the 10:00 minute, a normal full session.
const NOW = Date.UTC(2026, 8, 30, 14, 0, 30) / 1000;
const DAY = 86_400;

async function load(now: number, tf: Timeframe, symbol: string) {
  app = buildServer({ engine: createSyntheticEngine(), now: () => now });
  const snap = (await app.inject({ method: 'GET', url: `/api/snapshot?symbol=${symbol}` })).json<ApiResult<Snapshot>>();
  // Exactly the request the client makes: from = to - window, to = its own "now".
  const span = tf === '1D' ? 30 * DAY : tf === '1W' ? 90 * DAY : 2 * DAY;
  const bars = (await app.inject({ method: 'GET', url: `/api/bars?symbol=${symbol}&timeframe=${tf}&from=${now - span}&to=${now}` })).json<ApiResult<BarsResponse>>();
  if (!snap.ok || !bars.ok) throw new Error('expected both ok');
  return { snap: snap.data, bars: bars.data.bars };
}

describe('snapshot and the newest bar agree mid-session', () => {
  it.each(['AAPL', 'MSFT', 'NVDA'])('%s 1D: close, open, high, low and volume match the header', async (symbol) => {
    const { snap, bars } = await load(NOW, '1D', symbol);
    const today = bars.at(-1);
    expect(today).toBeDefined();
    expect(today?.close).toBe(snap.price);
    expect(today?.open).toBe(snap.dayOpen);
    expect(today?.high).toBe(snap.dayHigh);
    expect(today?.low).toBe(snap.dayLow);
    expect(today?.volume).toBe(snap.dayVolume);
  });

  it.each<Timeframe>(['1m', '5m', '15m', '1h', '1W'])('AAPL %s: the newest bar closes at the header price', async (tf) => {
    const { snap, bars } = await load(NOW, tf, 'AAPL');
    expect(bars.at(-1)?.close).toBe(snap.price);
  });

  it('1m: the newest bar is the last COMPLETED minute (09:59), not the in-progress 10:00', async () => {
    const { bars } = await load(NOW, '1m', 'AAPL');
    expect(bars.at(-1)?.time).toBe(Date.UTC(2026, 8, 30, 13, 59, 0) / 1000);
  });

  it('agree at several instants through the session, including on the minute boundary', async () => {
    for (const [h, m, s] of [[13, 31, 0], [13, 31, 59], [15, 17, 42], [19, 59, 59], [20, 5, 0]] as const) {
      const now = Date.UTC(2026, 8, 30, h, m, s) / 1000;
      const { snap, bars } = await load(now, '1D', 'AAPL');
      expect(bars.at(-1)?.close, `${h}:${m}:${s}Z`).toBe(snap.price);
      expect(bars.at(-1)?.volume, `${h}:${m}:${s}Z`).toBe(snap.dayVolume);
      await app?.close();
    }
  });
});
