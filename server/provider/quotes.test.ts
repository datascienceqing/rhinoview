import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@shared/types';
import { QuotesCache } from '../cache/quotesCache';
import { ApiFailure } from './errors';
import { QUOTE_CONCURRENCY, QuoteService, parseSymbolsParam } from './quotes';

const snap = (symbol: string): Snapshot => ({ symbol, price: 10, change: 1, changePercent: 0.1, previousClose: 9, dayOpen: 9, dayHigh: 11, dayLow: 8, dayVolume: 100, updated: 1, delayed: true });
const unknown = (s: string) => new ApiFailure('UNKNOWN_SYMBOL', `Unknown symbol: ${s}`);

type Behaviour = (symbol: string) => Promise<Snapshot> | Snapshot;
function build(behaviour: Behaviour, opts: { cache?: QuotesCache } = {}) {
  const snapshot = vi.fn(async (s: string) => behaviour(s));
  return { snapshot, quotes: new QuoteService({ service: { snapshot }, ...opts }) };
}
/** A snapshot that resolves canonical upper case, like the real service. */
const canonical: Behaviour = (s) => snap(s.toUpperCase());
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('parseSymbolsParam', () => {
  it.each([undefined, '', '   ', ',', 'AAPL,', ',AAPL', 'AAPL,,MSFT', 'A'.repeat(17), 'AA PL', 'AAPL;MSFT', ['AAPL', 'MSFT']])('rejects %j as BAD_REQUEST', (raw) => {
    expect(() => parseSymbolsParam(raw)).toThrowError(ApiFailure);
    try {
      parseSymbolsParam(raw);
    } catch (e) {
      expect((e as ApiFailure).code).toBe('BAD_REQUEST');
    }
  });

  it('rejects more than 50 entries and accepts exactly 50', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `S${i}`).join(',');
    expect(() => parseSymbolsParam(n(51))).toThrowError(ApiFailure);
    expect(parseSymbolsParam(n(50))).toHaveLength(50);
  });

  it('accepts class shares and trims whitespace', () => {
    expect(parseSymbolsParam(' brk.b , BF-B,BRK.B')).toEqual(['brk.b', 'BF-B', 'BRK.B']);
  });
});

describe('QuoteService.getQuotes', () => {
  it('returns quotes in request order with canonical casing', async () => {
    const { quotes } = build(canonical);
    const r = await quotes.getQuotes(['msft', 'Aapl', 'NVDA']);
    expect(r.quotes.map((q) => q.symbol)).toEqual(['MSFT', 'AAPL', 'NVDA']);
  });

  it('de-duplicates case-insensitively and fetches each symbol once', async () => {
    const { quotes, snapshot } = build(canonical);
    const r = await quotes.getQuotes(['AAPL', 'aapl', 'MSFT', 'Aapl']);
    expect(r.quotes.map((q) => q.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('lists a symbol once when two spellings resolve to the same canonical symbol', async () => {
    const { quotes } = build((s) => snap(s === 'GOOG.ALIAS' ? 'GOOG' : s));
    expect((await quotes.getQuotes(['GOOG', 'GOOG.ALIAS'])).quotes.map((q) => q.symbol)).toEqual(['GOOG']);
  });

  it('partial success: unknown goes to missing (as spelled), failed fetch to failed, neither fails the request', async () => {
    const { quotes } = build((s) => {
      if (s === 'zzzz') throw unknown(s);
      if (s === 'SLOW') throw new ApiFailure('RATE_LIMITED', 'Rate limit', 3);
      return snap(s.toUpperCase());
    });
    const r = await quotes.getQuotes(['AAPL', 'zzzz', 'SLOW', 'MSFT']);
    expect(r).toEqual({ quotes: [snap('AAPL'), snap('MSFT')], missing: ['zzzz'], failed: ['SLOW'] });
  });

  it('an unmapped throw counts as failed (UPSTREAM_ERROR), not as a crash', async () => {
    const { quotes } = build((s) => {
      if (s === 'BAD') throw new Error('boom with secret');
      return snap(s);
    });
    expect((await quotes.getQuotes(['AAPL', 'BAD'])).failed).toEqual(['BAD']);
  });

  it('all symbols unknown is still a success with everything in missing', async () => {
    const { quotes } = build((s) => {
      throw unknown(s);
    });
    expect(await quotes.getQuotes(['AAA', 'BBB'])).toEqual({ quotes: [], missing: ['AAA', 'BBB'], failed: [] });
  });

  it('every symbol failed: rejects with the FIRST failure in request order, keeping retryAfterSeconds', async () => {
    const { quotes } = build(async (s) => {
      // The later symbol fails first in time; request order must still decide.
      if (s === 'A') {
        await tick();
        throw new ApiFailure('RATE_LIMITED', 'limited', 7);
      }
      throw new ApiFailure('UPSTREAM_TIMEOUT', 'timeout');
    });
    const err = await quotes.getQuotes(['A', 'B']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 7 });
  });

  describe('shared cache', () => {
    it('serves a repeat from the cache: one upstream call across two requests', async () => {
      const { quotes, snapshot } = build(canonical);
      await quotes.getQuotes(['AAPL']);
      await quotes.getQuotes(['aapl', 'MSFT']);
      expect(snapshot.mock.calls.map((c) => c[0])).toEqual(['AAPL', 'MSFT']);
    });

    it('two services sharing one cache fetch a shared symbol once', async () => {
      const cache = new QuotesCache();
      const a = build(canonical, { cache });
      const b = build(canonical, { cache });
      await a.quotes.getQuotes(['AAPL']);
      await b.quotes.getQuotes(['AAPL']);
      expect(a.snapshot).toHaveBeenCalledTimes(1);
      expect(b.snapshot).not.toHaveBeenCalled();
    });

    it('caches successes only: failures and unknowns are fetched again', async () => {
      let n = 0;
      const { quotes, snapshot } = build((s) => {
        if (s === 'FLAKY' && n++ === 0) throw new ApiFailure('UPSTREAM_ERROR', 'down');
        if (s === 'NOPE') throw unknown(s);
        return snap(s);
      });
      expect((await quotes.getQuotes(['FLAKY', 'NOPE', 'OK'])).failed).toEqual(['FLAKY']);
      const second = await quotes.getQuotes(['FLAKY', 'NOPE', 'OK']);
      expect(second.quotes.map((q) => q.symbol)).toEqual(['FLAKY', 'OK']);
      expect(snapshot.mock.calls.filter((c) => c[0] === 'FLAKY')).toHaveLength(2);
      expect(snapshot.mock.calls.filter((c) => c[0] === 'NOPE')).toHaveLength(2);
      expect(snapshot.mock.calls.filter((c) => c[0] === 'OK')).toHaveLength(1);
    });

    it('concurrent requests for one symbol share a single in-flight fetch', async () => {
      const g = gate();
      const { quotes, snapshot } = build(async (s) => {
        await g.p;
        return snap(s);
      });
      const both = Promise.all([quotes.getQuotes(['AAPL']), quotes.getQuotes(['AAPL'])]);
      await tick();
      g.open();
      await both;
      expect(snapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency', () => {
    it('never has more than 5 fetches in flight, and uses all 5', async () => {
      expect(QUOTE_CONCURRENCY).toBe(5);
      let active = 0;
      let peak = 0;
      const { quotes } = build(async (s) => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return snap(s);
      });
      const r = await quotes.getQuotes(Array.from({ length: 23 }, (_, i) => `S${i}`));
      expect(r.quotes).toHaveLength(23);
      expect(peak).toBe(5);
    });

    it('one slow symbol does not block the others', async () => {
      const g = gate();
      const finished: string[] = [];
      const { quotes } = build(async (s) => {
        if (s === 'S0') await g.p;
        finished.push(s);
        return snap(s);
      });
      const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
      const result = quotes.getQuotes(symbols);
      // While S0 hangs, the other 19 must all complete using the remaining slots.
      await vi.waitFor(() => expect(finished).toHaveLength(19));
      expect(finished).not.toContain('S0');
      g.open();
      const r = await result;
      // Response order is request order regardless of completion order.
      expect(r.quotes.map((q) => q.symbol)).toEqual(symbols);
    });
  });
});
