/**
 * Regenerates mocks/fundamentals.generated.json: the client's MSW fundamentals data,
 * produced by the REAL server mapper (W2) over the recorded FMP fixtures.
 *
 * The client mock therefore cannot drift from the server mapping (Gate 5 finding F3).
 * A server test (server/fundamentals/generatedMock.test.ts) fails when this file is stale.
 *
 *   npx tsx scripts/gen-fundamentals-mock.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFundamentalsMockData } from '../server/fundamentals/fmp/mockData';

const out = fileURLToPath(new URL('../mocks/fundamentals.generated.json', import.meta.url));
const data = await buildFundamentalsMockData();
writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
console.log(`wrote ${out} (${Object.keys(data.overview).length} symbols)`);
