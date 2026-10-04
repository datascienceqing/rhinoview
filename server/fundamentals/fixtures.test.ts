/**
 * Recorded FMP fixtures are committed to the repository. This guards that none of them
 * carries a credential: the request path is stored without the key, and nothing else
 * in a recorded body should contain one.
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

describe('recorded FMP fixtures', () => {
  const files = ROOTS.flatMap(jsonFiles);

  it('exist', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s contains no apikey parameter', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/apikey/i);
  });
});
