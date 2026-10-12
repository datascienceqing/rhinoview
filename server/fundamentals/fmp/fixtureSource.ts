/**
 * Replay of the FMP fixture responses (synthetic values) as an `FmpJsonSource`, for tests and for offline
 * use of the mapper.
 *
 * Run the mapper over the fixtures (for example to generate client mock data):
 *
 *   import { createFixtureFundamentals } from './server/fundamentals/fmp/fixtureSource';
 *   const provider = createFixtureFundamentals();            // FundamentalsProvider
 *   const overview = await provider.getOverview('MSFT');
 *   const income = await provider.getStatements('MSFT', 'income', 'quarter');
 *   const earnings = await provider.getEarnings('MSFT');
 *   const news = await provider.getNews('AAPL');            // every page answers the one fixture
 *
 * Symbols with fixtures: AAPL, MSFT, JPM, TSM, RIVN. Any other symbol answers `[]`, which
 * the provider reads as an unknown symbol, exactly like FMP does. A fixture 402 throws
 * `FmpPaymentRequiredError`, like the real client. Each request is served from
 * `__fixtures__/fmp/<SYMBOL>/<name>.json`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FmpPaymentRequiredError, FmpUpstreamError } from '../../market/fmp/client';
import { FmpFundamentalsProvider } from './provider';
import type { FmpJsonSource } from './provider';

export const FIXTURE_ROOT = fileURLToPath(new URL('../__fixtures__/fmp', import.meta.url));

const STATEMENT_FILE: Record<string, string> = {
  '/income-statement': 'income',
  '/balance-sheet-statement': 'balance',
  '/cash-flow-statement': 'cashflow',
};

export function fixtureName(path: string, params: Record<string, string | number>): string {
  const stmt = STATEMENT_FILE[path];
  if (stmt) return `${stmt}-${String(params.period)}`;
  if (path === '/news/stock') return 'news';
  return path.replace(/^\//, '');
}

export function createFixtureSource(root: string = FIXTURE_ROOT): FmpJsonSource {
  return {
    getJson(path, params) {
      // `/news/stock` takes `symbols`; every other endpoint takes `symbol`.
      const symbol = String(params.symbol ?? params.symbols);
      const file = join(root, symbol, `${fixtureName(path, params)}.json`);
      // No fixture for the symbol: what FMP answers for a symbol it does not know.
      if (!existsSync(file)) return Promise.resolve([]);
      const rec = JSON.parse(readFileSync(file, 'utf8')) as { status: number; body: unknown };
      if (rec.status === 402) return Promise.reject(new FmpPaymentRequiredError('endpoint'));
      if (rec.status !== 200) return Promise.reject(new FmpUpstreamError(`FMP ${path} returned HTTP ${rec.status}`));
      // A limit asks for the newest N rows; the recordings already hold at most the limit.
      return Promise.resolve(rec.body);
    },
  };
}

export function createFixtureFundamentals(opts: { root?: string; now?: () => number } = {}): FmpFundamentalsProvider {
  return new FmpFundamentalsProvider({ source: createFixtureSource(opts.root), ...(opts.now ? { now: opts.now } : {}) });
}
