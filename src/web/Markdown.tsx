import type { CSSProperties, ReactNode } from 'react';
import { markdownTableAlignments, markdownTableRow } from './markdown.ts';
import type { MarkdownVeil } from './markdown-blocks.ts';

const PENDING_LINK_URL = 'https://pending.invalid/';

function safeHref(value: string) {
  if (value === PENDING_LINK_URL) return undefined;
  return /^(https?:|mailto:|#\/)/i.test(value) ? value : undefined;
}

function pushVeiledText(
  nodes: ReactNode[],
  value: string,
  sourceStart: number,
  prefix: string,
  veils: MarkdownVeil[],
) {
  if (!value) return;
  const cuts = new Set([0, value.length]);
  for (const veil of veils) {
    const start = Math.max(0, veil.start - sourceStart);
    const end = Math.min(value.length, veil.end - sourceStart);
    if (start > 0 && start < value.length) cuts.add(start);
    if (end > 0 && end < value.length) cuts.add(end);
  }
  const ordered = [...cuts].sort((left, right) => left - right);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    if (start === end) continue;
    const text = value.slice(start, end);
    const veil = veils.find(item => item.start <= sourceStart + start && sourceStart + end <= item.end);
    if (veil && veil.opacity < 1) {
      nodes.push(
        <span
          className="stream-veil"
          key={`${prefix}-veil-${sourceStart + start}-${sourceStart + end}`}
          style={{ opacity: veil.opacity } as CSSProperties}
        >
          {text}
        </span>,
      );
    } else {
      nodes.push(text);
    }
  }
}

function inline(
  text: string,
  prefix: string,
  sourceStart: number,
  veils: MarkdownVeil[],
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  let bufferStart = sourceStart;
  let index = 0;
  let key = 0;

  const flush = () => {
    if (!buffer) return;
    pushVeiledText(nodes, buffer, bufferStart, `${prefix}-text-${key++}`, veils);
    buffer = '';
  };

  while (index < text.length) {
    const rest = text.slice(index);
    if (rest[0] === '\n') {
      flush();
      nodes.push(<br key={`${prefix}-br-${key++}`} />);
      index += 1;
      continue;
    }

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push(
        <code key={`${prefix}-code-${key++}`}>
          {inline(code[1]!, `${prefix}-code-${key}`, sourceStart + index + 1, veils)}
        </code>,
      );
      index += code[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      flush();
      nodes.push(
        <strong key={`${prefix}-strong-${key++}`}>
          {inline(strong[2]!, `${prefix}-strong-${key}`, sourceStart + index + strong[1]!.length, veils)}
        </strong>,
      );
      index += strong[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      const href = safeHref(link[2]!);
      const content = inline(link[1]!, `${prefix}-link-text-${key}`, sourceStart + index + 1, veils);
      nodes.push(href
        ? <a key={`${prefix}-link-${key++}`} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noreferrer' : undefined}>{content}</a>
        : <span key={`${prefix}-link-${key++}`}>{content}</span>);
      index += link[0].length;
      continue;
    }

    const emphasis = /^(?:\*([^*\n]+)\*|_([^_\n]+)_)/.exec(rest);
    if (emphasis) {
      flush();
      nodes.push(
        <em key={`${prefix}-em-${key++}`}>
          {inline((emphasis[1] ?? emphasis[2])!, `${prefix}-em-${key}`, sourceStart + index + 1, veils)}
        </em>,
      );
      index += emphasis[0].length;
      continue;
    }

    if (!buffer) bufferStart = sourceStart + index;
    buffer += rest[0];
    index += 1;
  }
  flush();
  return nodes;
}

function startsBlock(line: string) {
  return /^(#{1,6})\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line)
    || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^---+$/.test(line);
}

interface SourceLine {
  text: string;
  start: number;
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start });
    start += line.length + 1;
  }
  return lines;
}

export function Markdown({ text, veils = [] }: { text: string; veils?: MarkdownVeil[] }) {
  const source = text.replace(/\r\n?/g, '\n');
  const lines = sourceLines(source);
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index]!.text;
    if (!line.trim()) { index += 1; continue; }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      const codeStart = lines[index + 1]?.start ?? lines[index]!.start + line.length + 1;
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!.text)) {
        code.push(lines[index]!.text);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const rendered: ReactNode[] = [];
      pushVeiledText(rendered, code.join('\n'), codeStart, `code-${key}`, veils);
      blocks.push(<pre key={`block-${key++}`}><code className={language ? `language-${language}` : undefined}>{rendered}</code></pre>);
      continue;
    }

    if (/^---+$/.test(line)) {
      blocks.push(<hr key={`block-${key++}`} />);
      index += 1;
      continue;
    }

    const header = markdownTableRow(line);
    const divider = index + 1 < lines.length ? markdownTableRow(lines[index + 1]!.text) : null;
    const alignments = divider ? markdownTableAlignments(divider) : null;
    if (header && alignments && header.length === alignments.length) {
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor]!.text.trim()) {
        const row = markdownTableRow(lines[cursor]!.text);
        if (!row) break;
        rows.push(alignments.map((_, column) => row[column] ?? ''));
        cursor += 1;
      }
      const tableKey = key++;
      blocks.push(
        <div className="markdown-table-wrap" key={`block-${tableKey}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, column) => (
                  <th key={`head-${column}`} data-align={alignments[column] ?? undefined}>
                    {inline(cell, `table-${tableKey}-head-${column}`, lines[index]!.start, veils)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {row.map((cell, column) => (
                    <td key={`cell-${column}`} data-align={alignments[column] ?? undefined}>
                      {inline(cell, `table-${tableKey}-${rowIndex}-${column}`, lines[index + 2 + rowIndex]?.start ?? lines[index]!.start, veils)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      index = cursor;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = inline(heading[2]!, `heading-${key}`, lines[index]!.start + level + 1, veils);
      if (level === 1) blocks.push(<h1 key={`block-${key++}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`block-${key++}`}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={`block-${key++}`}>{content}</h3>);
      else blocks.push(<h4 key={`block-${key++}`}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      const quoteStart = lines[index]!.start;
      while (index < lines.length && /^>\s?/.test(lines[index]!.text)) {
        quote.push(lines[index]!.text.replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`block-${key++}`}>
          {inline(quote.join('\n'), `quote-${key}`, quoteStart, veils)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      const itemStarts: number[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!.text)) {
        const marker = /^[-*]\s+/.exec(lines[index]!.text)![0].length;
        itemStarts.push(lines[index]!.start + marker);
        items.push(lines[index]!.text.replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`block-${key++}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>
              {inline(item, `ul-${key}-${itemIndex}`, itemStarts[itemIndex]!, veils)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      const itemStarts: number[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!.text)) {
        const marker = /^\d+\.\s+/.exec(lines[index]!.text)![0].length;
        itemStarts.push(lines[index]!.start + marker);
        items.push(lines[index]!.text.replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`block-${key++}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>
              {inline(item, `ol-${key}-${itemIndex}`, itemStarts[itemIndex]!, veils)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    const paragraphStart = lines[index]!.start;
    index += 1;
    while (index < lines.length && lines[index]!.text.trim() && !startsBlock(lines[index]!.text)) {
      paragraph.push(lines[index]!.text);
      index += 1;
    }
    blocks.push(
      <p key={`block-${key++}`}>
        {inline(paragraph.join('\n'), `paragraph-${key}`, paragraphStart, veils)}
      </p>,
    );
  }

  return <div className="markdown-body">{blocks}</div>;
}
