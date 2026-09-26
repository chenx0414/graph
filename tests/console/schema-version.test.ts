import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '../../src/core/store.ts';

// The migration list is data the runtime keeps in one place, and the two ways it has actually gone
// wrong are invisible at runtime: adding a `version < N` block without bumping SCHEMA_VERSION
// (every reopen then refuses the database this very process just created), and stamping a block
// with the wrong `user_version`. Both are source-level invariants, so the guard reads the source
// instead of restating the list.
async function storeSource(): Promise<string> {
  return readFile(join(dirname(fileURLToPath(import.meta.url)), '../../src/core/store.ts'), 'utf8');
}

test('the schema version is the highest migration marker the store carries', async () => {
  const source = await storeSource();
  const markers = [...source.matchAll(/if \(version < (\d+)\)/g)].map(match => Number(match[1]));
  expect(markers.length).toBeGreaterThan(20);
  expect(Math.max(...markers)).toBe(SCHEMA_VERSION);
});

test('every migration stamps the version it guards', async () => {
  const source = await storeSource();
  const markers = [...source.matchAll(/if \(version < (\d+)\)/g)]
    .map(match => ({ marker: Number(match[1]), at: match.index }));
  expect(markers.length).toBeGreaterThan(20);
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1]?.at ?? source.length;
    const stamped = /PRAGMA user_version=(\d+)/.exec(source.slice(marker.at, end));
    expect(stamped, `migration ${marker.marker} stamps nothing`).not.toBeNull();
    expect(Number(stamped![1]), `migration ${marker.marker} stamps the wrong version`).toBe(marker.marker);
  }
});
