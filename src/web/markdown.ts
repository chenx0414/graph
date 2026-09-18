export type TableAlignment = 'left' | 'center' | 'right' | null;

/** Split a GFM table row while preserving escaped pipes inside cells. */
export function markdownTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null;
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '\\' && value[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function markdownTableAlignments(cells: string[]): TableAlignment[] | null {
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    alignments.push(value.startsWith(':') && value.endsWith(':') ? 'center'
      : value.endsWith(':') ? 'right'
        : value.startsWith(':') ? 'left'
          : null);
  }
  return alignments.length ? alignments : null;
}
