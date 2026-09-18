import { markdownTableAlignments, markdownTableRow } from './markdown.ts';

export interface MarkdownBlock {
  index: number;
  start: number;
  end: number;
  source: string;
}

export interface MarkdownVeil {
  start: number;
  end: number;
  opacity: number;
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

function startsBlock(line: string) {
  return /^(#{1,6})\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line)
    || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^---+$/.test(line);
}

function tableStart(lines: SourceLine[], index: number) {
  const header = markdownTableRow(lines[index]?.text ?? '');
  const divider = markdownTableRow(lines[index + 1]?.text ?? '');
  return Boolean(header && divider && markdownTableAlignments(divider)?.length === header.length);
}

/**
 * Split a Markdown document into the same top-level shapes rendered by
 * Markdown.tsx. Stable source ranges let React memoize every settled block and
 * only remount/reparse the last two while text is streaming.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = sourceLines(text);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const push = (start: number, endLine: number) => {
    const startOffset = lines[start]?.start ?? text.length;
    const endOffset = endLine < lines.length ? lines[endLine]!.start : text.length;
    const source = text.slice(startOffset, endOffset);
    if (!source.trim()) return;
    blocks.push({ index: blocks.length, start: startOffset, end: endOffset, source });
  };

  while (index < lines.length) {
    if (!lines[index]!.text.trim()) {
      index += 1;
      continue;
    }
    const start = index;
    const line = lines[index]!.text;

    if (/^```/.test(line)) {
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!.text)) index += 1;
      if (index < lines.length) index += 1;
      push(start, index);
      continue;
    }
    if (/^---+$/.test(line) || /^(#{1,6})\s+/.test(line)) {
      index += 1;
      push(start, index);
      continue;
    }
    if (tableStart(lines, index)) {
      index += 2;
      while (index < lines.length && lines[index]!.text.trim() && lines[index]!.text.includes('|')) index += 1;
      push(start, index);
      continue;
    }
    if (/^>\s?/.test(line)) {
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index]!.text)) index += 1;
      push(start, index);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      index += 1;
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!.text)) index += 1;
      push(start, index);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      index += 1;
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!.text)) index += 1;
      push(start, index);
      continue;
    }
    index += 1;
    while (index < lines.length && lines[index]!.text.trim() && !startsBlock(lines[index]!.text)) index += 1;
    push(start, index);
  }
  return blocks;
}

function markerCount(text: string, marker: string) {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(marker, index)) >= 0) {
    count += 1;
    index += marker.length;
  }
  return count;
}

/**
 * Close only display-level Markdown markers that are still hanging. The
 * canonical source is never rewritten; this keeps already painted text from
 * reflowing when the real closing marker arrives later.
 */
export function mendStreamingMarkdown(source: string) {
  if (!source) return source;
  // An unclosed fence already renders verbatim and must not gain a fake fence.
  if (markerCount(source, '```') % 2 === 1) return source;

  let mended = source;
  const visible = mended.replace(/`[^`\n]*`/g, '');
  if (markerCount(visible, '**') % 2 === 1) mended += '**';
  const withoutStrong = visible.replace(/\*\*/g, '');
  if (markerCount(withoutStrong, '*') % 2 === 1) mended += '*';
  if (markerCount(withoutStrong, '_') % 2 === 1) mended += '_';
  if (markerCount(visible, '`') % 2 === 1) mended += '`';

  const lastOpen = mended.lastIndexOf('[');
  const lastClose = mended.lastIndexOf(']');
  if (lastOpen > lastClose) mended += '](https://pending.invalid/)';
  return mended;
}
