/**
 * FMP fixtures are committed to the repository. This guards two things:
 *  - none of them carries a credential (the request path is stored without the key);
 *  - every data fixture is SYNTHETIC. Real FMP data may not be redistributed, so a
 *    recorded response must go through scripts/gen-synthetic-fmp-fixtures.ts before it
 *    is committed. Only error bodies, empty answers, split events and search listings
 *    stay as recorded (see that script).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['server/fundamentals/__fixtures__', 'server/market/fmp/__fixtures__'];

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return jsonFiles(p);
    return p.endsWith('.json') ? [p] : [];
  });
}

describe('FMP fixtures', () => {
  const files = ROOTS.flatMap(jsonFiles);

  it('exist', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s contains no apikey parameter', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/apikey/i);
  });

  // Files the generator keeps as recorded: no market or company figures in them.
  const AS_RECORDED = /(^|\/)(search-[^/]*|splits-[^/]*)\.json$/;

  it.each(files)('%s holds synthetic data, or no market data at all', (file) => {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { status?: number; body?: unknown; synthetic?: boolean };
    let body = rec.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // a plain-text error body
      }
    }
    const hasData = rec.status === 200 && Array.isArray(body) && body.length > 0;
    if (hasData && !AS_RECORDED.test(file)) expect(rec.synthetic, file).toBe(true);
  });
});
