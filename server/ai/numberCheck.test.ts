import { describe, expect, it } from 'vitest';
import { checkNumbers, textNumbers } from './numberCheck';
import { directionOf, reasonOf } from './load';
import { parseSkill } from './skills';

describe('checkNumbers', () => {
  const facts = { plans: [{ stop: 326.0, targets: [{ price: 263.02, rr: 2.8 }, { price: 254.68, rr: 3.3 }] }], mas: [{ distancePct: -17.15 }], quote: { last: 1660.46 } };

  it('marks the wrong T2 R:R of sample 002 (4.3 for 3.3)', () => {
    const r = checkNumbers('T1 $263.02 (R:R 2.8:1) • T2 $254.68 (R:R 4.3:1)', facts);
    expect(r.unknown).toEqual(['4.3']);
    expect(r.checked).toBe(4);
  });

  it('accepts a fact rounded to the decimals of the text, and ignores the sign', () => {
    expect(checkNumbers('17.1% below EMA20, then 17.2%, stop 326', facts).unknown).toEqual([]);
    expect(checkNumbers('price $1,660.46', facts).unknown).toEqual([]);
  });

  it('skips dates, indicator names, target names, and small counts', () => {
    expect(textNumbers('EMA200 on 2026-10-27, T1, Q3, 7 of 10 rows, 4H')).toEqual(['7', '10', '4']);
    expect(checkNumbers('EMA200 on 2026-10-27, T1, 7 of 10 rows', facts).checked).toBe(0);
  });
});

describe('directionOf', () => {
  it.each([
    ['Can I short CAT? It seems to break the support.', 'short'],
    ['Can I short SNDK here?', 'short'],
    ['Is it a good entry point for STX?', null],
    ['Should I buy NVDA?', 'long'],
    ['可以做空 TER 吗？', 'short'],
    ['Long or short AAPL?', null],
  ])('%s → %s', (q, d) => {
    expect(directionOf(q)).toBe(d);
  });
});

describe('reasonOf', () => {
  it('takes the sentences after the question, or the part after "because"', () => {
    expect(reasonOf('Can I short CAT? It seems to break the support.')).toBe('It seems to break the support.');
    expect(reasonOf('Can I buy AMD because it broke out')).toBe('it broke out');
    expect(reasonOf('Can I short TER?')).toBeNull();
  });
});

describe('parseSkill', () => {
  it('keeps the body, reads the version, and adds the common rules', () => {
    const s = parseSkill('trade-check', '---\nname: trade-check\nversion: 1.2.3\n---\n\n# Skill\n\nBody.');
    expect(s.version).toBe('1.2.3');
    expect(s.body.startsWith('# Skill\n\nBody.')).toBe(true);
    expect(s.body).toContain('language of the question');
  });
});
