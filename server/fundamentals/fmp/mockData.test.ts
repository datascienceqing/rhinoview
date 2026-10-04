import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFundamentalsMockData } from './mockData';

const FILE = fileURLToPath(new URL('../../../mocks/fundamentals.generated.json', import.meta.url));

describe('client fundamentals mock data', () => {
  it('equals the real FMP mapping over the recorded fixtures (run scripts/gen-fundamentals-mock.ts if not)', async () => {
    const onDisk: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(onDisk).toEqual(await buildFundamentalsMockData());
  });
});
