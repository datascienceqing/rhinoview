/**
 * Test helpers: replay FMP fixture responses through `FetchLike`, no network.
 * Fixtures in `__fixtures__/` have the shape of real FMP responses, with SYNTHETIC values
 * (scripts/gen-synthetic-fmp-fixtures.ts). Error bodies are FMP's own text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './client';

export const TEST_KEY = 'test-fmp-key-Zx9Qw7Lm3Vb5';

interface Fixture {
  status: number;
  contentType: string | null;
  body: string;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), 'utf8')) as Fixture;
}

export function responseOf(f: { status: number; body: string }, headers: Record<string, string> = {}): Response {
  return new Response(f.body, { status: f.status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The parsed JSON rows of a 200 fixture. */
export function fixtureRows<T = Record<string, unknown>>(name: string): T[] {
  return JSON.parse(loadFixture(name).body) as T[];
}

export interface FakeFetch extends FetchLike {
  calls: URL[];
}

/** Serve `handler`'s response for every request, recording each request URL. */
export function fakeFetch(handler: (url: URL, call: number) => Response | Promise<Response>): FakeFetch {
  const calls: URL[] = [];
  const fn = (url: string) => {
    const u = new URL(url);
    calls.push(u);
    return Promise.resolve(handler(u, calls.length - 1));
  };
  return Object.assign(fn, { calls });
}

/** Route by endpoint path to a fixture name (or a ready Response). */
export function routedFetch(routes: Record<string, string | ((url: URL) => Response)>): FakeFetch {
  return fakeFetch((url) => {
    const route = routes[url.pathname.replace(/^.*\/stable/, '')];
    if (route === undefined) throw new Error(`unexpected request: ${url.pathname}`);
    return typeof route === 'string' ? responseOf(loadFixture(route)) : route(url);
  });
}
