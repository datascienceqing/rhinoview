/**
 * Skill files: the system prompts of the AI helper. A skill is Markdown with a YAML front
 * matter block; the model gets the body, and the server keeps the front matter.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type SkillName = 'trade-check' | 'alert-explain';

export interface Skill {
  name: SkillName;
  version: string;
  body: string;
}

const SKILL_DIR = fileURLToPath(new URL('./skills/', import.meta.url));

/** Rules for every skill, about the input format and the language. The skill file has the method. */
const COMMON_RULES = `

## Input format and language

- The user message is one JSON object: \`{ "question": ..., "facts": ... }\`.
- \`facts\` follows the "Input" section above. A field that is null or absent is missing data.
- Prices in \`facts\` are rounded. Quote them as they are. Do not round them again.
- Write the answer in the language of the question. Keep the names of indicators and patterns (EMA, RSI, BOS, CHoCH, FVG) in English.
- Use Markdown. Do not write a title line.
`;

export function parseSkill(name: SkillName, text: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`Skill ${name} has no front matter.`);
  const version = /^version:\s*(\S+)/m.exec(m[1] as string)?.[1] ?? 'unknown';
  return { name, version, body: `${(m[2] as string).trim()}\n${COMMON_RULES}` };
}

const cache = new Map<SkillName, Promise<Skill>>();

export function loadSkill(name: SkillName): Promise<Skill> {
  let hit = cache.get(name);
  if (!hit) {
    hit = readFile(`${SKILL_DIR}${name}.md`, 'utf8').then((text) => parseSkill(name, text));
    cache.set(name, hit);
  }
  return hit;
}
