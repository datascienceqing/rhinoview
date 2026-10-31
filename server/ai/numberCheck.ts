/**
 * The number check of docs/AI_HELPER_PLAN.md, section 3: each number in the answer must be
 * in the facts. The samples had wrong R:R values, wrong counts, and wrong percents; this
 * check marks such numbers for the user.
 *
 * A number in the text matches a fact when the fact, rounded to the decimals that the text
 * shows, is within half a unit of the last digit (17.15 matches "17.1" and "17.2"). Signs are
 * ignored ("−5.2%" and "5.2% below" are the same number).
 * Only numbers that can carry an error are checked: a number with decimals, or an integer
 * of 100 or more. Small integers are counts, periods, and list numbers ("EMA20", "7 of 10").
 */
import type { AiNumberCheck } from '@shared/types';

/** Every finite number in a JSON-like value, also the numbers inside its strings (news titles, readings). */
export function factNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') for (const w of textNumbers(value)) out.push(Number(w.replace(/,/g, '')));
  else if (Array.isArray(value)) for (const v of value) factNumbers(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) factNumbers(v, out);
  return out;
}

/** The numbers of a text, as written. Dates, times, and names with digits are skipped. */
export function textNumbers(text: string): string[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ') // dates
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ') // times
    .replace(/\b(?:EMA|SMA|RSI|ATR|ADX|MACD|T|Q|FY|H|W|M|D)\d+\w*/gi, ' ') // EMA200, T1, Q3, 4H stays as "4"
    .replace(/\b\d+(?:\.\d+)?:\d+(?:\.\d+)?\b/g, (m) => ` ${m.split(':')[0]} `); // "2.8:1" checks 2.8
  return [...cleaned.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

function decimalsOf(written: string): number {
  const dot = written.indexOf('.');
  return dot < 0 ? 0 : written.length - dot - 1;
}

export function checkNumbers(text: string, facts: unknown): AiNumberCheck {
  const known = factNumbers(facts).map(Math.abs);
  const unknown: string[] = [];
  let checked = 0;
  for (const written of textNumbers(text)) {
    const value = Number(written.replace(/,/g, ''));
    const decimals = decimalsOf(written);
    if (decimals === 0 && value < 100) continue;
    checked++;
    const scale = 10 ** decimals;
    const hit = known.some((k) => Math.abs(k - value) <= 0.5 / scale + 1e-9);
    if (!hit && !unknown.includes(written)) unknown.push(written);
  }
  return { checked, unknown };
}
