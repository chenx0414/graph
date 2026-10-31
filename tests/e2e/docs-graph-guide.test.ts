import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The graph guide is the one document every Agent is told to read before it
// designs a graph, so it rots silently: a merge once replaced its body with 27
// empty headings, and nothing noticed until the graphs people asked for all
// came out the same shape. These assertions fail the moment that happens again.

const docs = join(import.meta.dirname, '..', '..', 'docs', 'agent');
const entry = join(docs, 'graph-v2.md');

test('the graph guide stays a guide: shape first, real topic files, no hollow sections', async () => {
  const guide = await readFile(entry, 'utf8');

  // The two rules an author needs before writing any node.
  expect(guide).toContain('## 先选形状，再写节点');
  expect(guide).toContain('## 每多加一个节点，说出它带来的新信息');
  // The shape questions themselves, not just a heading.
  expect(guide).toMatch(/能并行吗/);
  expect(guide).toMatch(/独立候选/);
  expect(guide).toMatch(/不可逆/);
  expect(guide).toContain('shapeNotes');
  // The named powers that history never used, so they stay discoverable.
  expect(guide).toContain('jury');
  expect(guide).toContain('router');

  // The exact rot that happened: a heading whose body is a placeholder.
  expect(guide).not.toContain('参见上方完整记录');

  // Every topic file the guide points at exists and carries real content.
  const linked = [...guide.matchAll(/\]\((graph-v2-[^)]+\.md)\)/g)].map(match => match[1] ?? '');
  expect(linked.length).toBeGreaterThanOrEqual(4);
  for (const name of linked.filter(Boolean)) {
    const path = join(docs, name);
    await access(path);
    const body = await readFile(path, 'utf8');
    // Short is fine (one topic file is a 23-line evidence record); empty is not.
    expect(body.split('\n').length, `${name} is a stub`).toBeGreaterThan(10);
    expect(body, `${name} still holds a placeholder`).not.toContain('参见上方完整记录');
  }
});
