import { describe, expect, it } from 'vitest';
import { selectEngine } from './engine';

describe('selectEngine', () => {
  it('fails loudly for DATA_PROVIDER=massive instead of falling back to synthetic', async () => {
    await expect(selectEngine('massive')).rejects.toThrow(/DATA_PROVIDER=massive is not implemented/);
  });
});
