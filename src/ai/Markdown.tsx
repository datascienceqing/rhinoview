/**
 * A small Markdown renderer for the AI answers: headings, paragraphs, lists, tables, code
 * blocks, **bold**, `code`, and http(s) links. It builds React elements and never sets
 * HTML, so a model answer cannot inject markup.
 *
 * `flagged` numbers (the server's number check) are wrapped in <mark>, wherever they occur
 * as a whole number in plain text.
 */
import type { ReactNode } from 'react';

export interface MarkdownProps {
  text: string;
  flagged?: readonly string[];
  flagTitle?: string;
}

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; text: string };

const cells = (line: string) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    if (t.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith('```')) body.push(lines[i++] as string);
      i++; // the closing fence
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      out.push({ kind: 'heading', text: h[1] as string });
      i++;
      continue;
    }
    if (t.startsWith('|') && /^\|?\s*:?-{3,}/.test((lines[i + 1] ?? '').trim())) {
      const head = cells(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).trim().startsWith('|')) rows.push(cells(lines[i++] as string));
      out.push({ kind: 'table', head, rows });
      continue;
    }
    const item = /^(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(t);
    if (item) {
      const ordered = Boolean(item[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec((lines[i] as string).trim());
        if (m && Boolean(m[2]) === ordered) {
          items.push(m[3] as string);
          i++;
        } else if (m === null && /^\s{2,}\S/.test(lines[i] as string) && items.length) {
          items[items.length - 1] += ` ${(lines[i] as string).trim()}`; // a wrapped item
          i++;
        } else break;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !/^(#{1,6}\s|```|\||[-*•]\s|\d+[.)]\s)/.test((lines[i] as string).trim())) {
      para.push((lines[i++] as string).trim());
    }
    if (para.length === 0) para.push(lines[i++]?.trim() ?? '');
    out.push({ kind: 'para', lines: para });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function flagNumbers(text: string, flagged: readonly string[], title: string, key: string): ReactNode[] {
  if (flagged.length === 0) return [text];
  // Whole numbers only: "4.3" must not match inside "14.35".
  const re = new RegExp(`(?<![\\d.,])(${flagged.map(escapeRe).join('|')})(?![\\d]|[.,]\\d)`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <mark key={`${key}-f${n++}`} className="ai-flagged" title={title}>
        {m[0]}
      </mark>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Bold, code, and links; plain text gets the number flags. */
export function inline(text: string, flagged: readonly string[] = [], title = '', key = 'i'): ReactNode[] {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(...flagNumbers(text.slice(last, at), flagged, title, `${key}-${n}`));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{inline(m[1], flagged, title, k)}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else
      out.push(
        <a key={k} href={m[4]} target="_blank" rel="noopener noreferrer">
          {m[3]}
        </a>,
      );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(...flagNumbers(text.slice(last), flagged, title, `${key}-${n}`));
  return out;
}

export function Markdown({ text, flagged = [], flagTitle = '' }: MarkdownProps) {
  const f = (s: string, key: string) => inline(s, flagged, flagTitle, key);
  return (
    <div className="ai-markdown">
      {parseBlocks(text).map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case 'heading':
            return <h4 key={k}>{f(b.text, k)}</h4>;
          case 'code':
            return <pre key={k}>{b.text}</pre>;
          case 'list': {
            const items = b.items.map((it, j) => <li key={`${k}-${j}`}>{f(it, `${k}-${j}`)}</li>);
            return b.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
          }
          case 'table':
            return (
              <div key={k} className="ai-table-wrap">
                <table>
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}>{f(c, `${k}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, x) => <td key={x}>{f(c, `${k}-${j}-${x}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={k}>
                {b.lines.flatMap((l, j) => (j === 0 ? f(l, `${k}-${j}`) : [<br key={`${k}-br${j}`} />, ...f(l, `${k}-${j}`)]))}
              </p>
            );
        }
      })}
    </div>
  );
}
