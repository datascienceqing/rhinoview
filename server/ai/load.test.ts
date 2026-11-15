import { describe, expect, it } from 'vitest';
import { resolveDirection } from './load';

describe('resolveDirection', () => {
  it('reads the question', () => {
    expect(resolveDirection('Can I short TER?')).toBe('short');
  });

  it('uses the newest earlier question with a direction for a follow-up', () => {
    expect(resolveDirection('Where is the stop?', ['Can I long TER?', 'And a short?'])).toBe('short');
    expect(resolveDirection('Where is the stop?', ['Can I long TER?', 'Why?'])).toBe('long');
  });

  it('is null when no question has a direction', () => {
    expect(resolveDirection('Is it a good entry?', ['What is the trend?'])).toBeNull();
  });
});
