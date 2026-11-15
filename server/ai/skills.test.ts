/**
 * The skill files: what the model gets, and that the "Input" section names the real facts.
 */
import { describe, expect, it } from 'vitest';
import { DEVELOPER_NOTES, loadSkill, parseSkill } from './skills';
import { buildFacts } from './facts/build';

describe('parseSkill', () => {
  it('reads the version, and removes the front matter and the developer notes', () => {
    const skill = parseSkill('trade-check', `---\nname: x\nversion: 1.2.3\n---\n# Skill\n\nMethod.\n\n${DEVELOPER_NOTES}\n\n# Notes\nBacktest.`);
    expect(skill.version).toBe('1.2.3');
    expect(skill.body).toContain('Method.');
    expect(skill.body).not.toContain('Backtest');
    expect(skill.body).not.toContain('name: x');
    expect(skill.body).toContain('Input format and language');
  });

  it('fails without front matter', () => {
    expect(() => parseSkill('trade-check', '# Skill')).toThrow();
  });
});

describe('trade-check skill', () => {
  it('does not send the developer notes to the model', async () => {
    const { body } = await loadSkill('trade-check');
    expect(body).not.toContain('Developer notes');
    expect(body.toLowerCase()).not.toContain('backtest');
    expect(body).not.toContain('**Missing**');
  });

  it('names every top-level field of the facts in the "Input" section', async () => {
    const { body } = await loadSkill('trade-check');
    const input = body.slice(body.indexOf('## Input'), body.indexOf('## Procedure'));
    const facts = buildFacts({
      symbol: 'X', question: 'Buy?', askedAt: 1_792_000_000, direction: null, reason: null, provider: 'synthetic', quote: null,
      bars: { '4h': [], '1D': [], '1W': [] }, earnings: [], analysts: null, news: [],
    });
    // `question` is beside the facts, and the model does not get `marks`.
    const fields = Object.keys(facts).filter((k) => k !== 'question' && k !== 'marks');
    const absent = fields.filter((k) => !input.includes(`\`${k}`));
    expect(absent).toEqual([]);
  });
});
