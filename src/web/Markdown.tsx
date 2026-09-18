import type { ReactNode } from 'react';
import { markdownTableAlignments, markdownTableRow } from './markdown.ts';

function safeHref(value: string) {
  return /^(https?:|mailto:|#\/)/i.test(value) ? value : undefined;
}

function inline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  let index = 0;
  let key = 0;

  const flush = () => {
    if (!buffer) return;
    nodes.push(buffer);
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
      nodes.push(<code key={`${prefix}-code-${key++}`}>{code[1]}</code>);
      index += code[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      flush();
      nodes.push(<strong key={`${prefix}-strong-${key++}`}>{inline(strong[2]!, `${prefix}-strong-${key}`)}</strong>);
      index += strong[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      const href = safeHref(link[2]!);
      if (href) {
        nodes.push(<a key={`${prefix}-link-${key++}`} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noreferrer' : undefined}>{inline(link[1]!, `${prefix}-link-text-${key}`)}</a>);
      } else {
        nodes.push(link[0]);
      }
      index += link[0].length;
      continue;
    }

    const emphasis = /^(?:\*([^*\n]+)\*|_([^_\n]+)_)/.exec(rest);
    if (emphasis) {
      flush();
      nodes.push(<em key={`${prefix}-em-${key++}`}>{inline((emphasis[1] ?? emphasis[2])!, `${prefix}-em-${key}`)}</em>);
      index += emphasis[0].length;
      continue;
    }

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

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`block-${key++}`}><code className={language ? `language-${language}` : undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    if (/^---+$/.test(line)) {
      blocks.push(<hr key={`block-${key++}`} />);
      index += 1;
      continue;
    }

    const header = markdownTableRow(line);
    const divider = index + 1 < lines.length ? markdownTableRow(lines[index + 1] ?? '') : null;
    const alignments = divider ? markdownTableAlignments(divider) : null;
    if (header && alignments && header.length === alignments.length) {
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && (lines[cursor] ?? '').trim()) {
        const row = markdownTableRow(lines[cursor] ?? '');
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
                  <th key={`head-${column}`} data-align={alignments[column] ?? undefined}>{inline(cell, `table-${tableKey}-head-${column}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {row.map((cell, column) => (
                    <td key={`cell-${column}`} data-align={alignments[column] ?? undefined}>{inline(cell, `table-${tableKey}-${rowIndex}-${column}`)}</td>
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
      const content = inline(heading[2]!, `heading-${key}`);
      if (level === 1) blocks.push(<h1 key={`block-${key++}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`block-${key++}`}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={`block-${key++}`}>{content}</h3>);
      else blocks.push(<h4 key={`block-${key++}`}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`block-${key++}`}>{inline(quote.join('\n'), `quote-${key}`)}</blockquote>);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`block-${key++}`}>{items.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{inline(item, `ul-${key}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`block-${key++}`}>{items.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{inline(item, `ol-${key}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !startsBlock(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(<p key={`block-${key++}`}>{inline(paragraph.join('\n'), `paragraph-${key}`)}</p>);
  }

  return <div className="markdown-body">{blocks}</div>;
}
