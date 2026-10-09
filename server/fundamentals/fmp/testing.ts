/**
 * Test helpers: serve the recorded FMP responses through the REAL `FmpClient`, so a
 * recorded 402 goes through the client's own 402 handling. No network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FmpClient } from '../../market/fmp/client';
import { FIXTURE_ROOT, fixtureName } from './fixtureSource';
import { FmpFundamentalsProvider } from './provider';

export const TEST_KEY = 'test-fmp-key-Zx9Qw7Lm3Vb5';

export interface FixtureRecord {
  status: number;
  path: string;
  body: unknown;
}

export function readFixture(symbol: string, name: string): FixtureRecord {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, symbol, `${name}.json`), 'utf8')) as FixtureRecord;
}

/** The rows of a 200 fixture. */
export function fixtureRows<T = Record<string, unknown>>(symbol: string, name: string): T[] {
  return readFixture(symbol, name).body as T[];
}

export type Override = (url: URL) => Response;

export interface RecordingFetch {
  (url: string): Promise<Response>;
  calls: URL[];
  /** The endpoint paths requested, e.g. `/profile`, in order. */
  paths(): string[];
}

export const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Serve fixtures by endpoint. `overrides` is keyed by endpoint path (`/ratios-ttm`) and
 * wins over the fixture. A symbol with no fixture answers `[]`, like FMP for an unknown one.
 */
export function fixtureFetch(overrides: Record<string, Override> = {}): RecordingFetch {
  const calls: URL[] = [];
  const fn = (raw: string): Promise<Response> => {
    const url = new URL(raw);
    calls.push(url);
    const path = url.pathname.replace(/^.*\/stable/, '');
    const override = overrides[path];
    if (override) return Promise.resolve(override(url));
    const symbol = url.searchParams.get('symbol') ?? '';
    const params = { period: url.searchParams.get('period') ?? '' };
    const file = join(FIXTURE_ROOT, symbol, `${fixtureName(path, params)}.json`);
    if (!existsSync(file)) return Promise.resolve(json([]));
    const rec = JSON.parse(readFileSync(file, 'utf8')) as FixtureRecord;
    return Promise.resolve(json(rec.body, rec.status));
  };
  return Object.assign(fn, { calls, paths: () => calls.map((u) => u.pathname.replace(/^.*\/stable/, '')) });
}

/** A provider over a real `FmpClient` whose transport is `fetch`. No retries, no waiting. */
export function providerOver(fetch: RecordingFetch, now: () => number = () => 1_790_000_000_000): FmpFundamentalsProvider {
  const client = new FmpClient({ apiKey: TEST_KEY, fetch, sleep: () => Promise.resolve(), maxRetries: 0 });
  return new FmpFundamentalsProvider({ source: client, now });
}
