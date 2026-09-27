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

/**
 * Adding a column is three fixed actions: bump `SCHEMA_VERSION`, add a `version < N` block, and update
 * every fixture that rolls a database back to an earlier shape. The third one is the step a person
 * forgets, and the only signal is a red gate in whichever test the leftover column happens to break -
 * which is why it is checked here over the two sources instead.
 */
type AddedColumn = { version: number; guarded: boolean };

function addedColumns(source: string): Map<string, AddedColumn> {
  const markers = [...source.matchAll(/if \(version < (\d+)\)/g)].map(match => ({ version: Number(match[1]), at: match.index }));
  const added = new Map<string, AddedColumn>();
  for (const [index, marker] of markers.entries()) {
    const block = source.slice(marker.at, markers[index + 1]?.at ?? source.length);
    // A block that reads `table_info` first can absorb a column that is already there; the rest cannot,
    // and those are the ones a rollback fixture has to remove.
    const guarded = block.includes('table_info');
    for (const hit of block.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
      added.set(`${hit[1]}.${hit[2]}`, { version: marker.version, guarded });
    }
  }
  return added;
}

type Rollback = { file: string; version: number; drops: Set<string>; tables: Set<string> };

/** Fixtures that roll a schema back, read from the SQL they run: a file that drops nothing is building a
 * legacy database from scratch, which is a different claim and not this check's business. */
function rollbacks(file: string, text: string): Rollback[] {
  const out: Rollback[] = [];
  for (const hit of text.matchAll(/PRAGMA user_version=(\d+)/g)) {
    const window = text.slice(Math.max(0, hit.index - 4_000), hit.index + 400);
    const drops = new Set([...window.matchAll(/ALTER TABLE (\w+) DROP COLUMN (\w+)/g)].map(match => `${match[1]}.${match[2]}`));
    const tables = new Set([...window.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)/g)].map(match => match[1]!));
    if (!drops.size && !tables.size) continue;
    out.push({ file, version: Number(hit[1]), drops, tables });
  }
  return out;
}

function rollbackGaps(source: string, fixtures: Rollback[]): string[] {
  const added = addedColumns(source);
  const gaps: string[] = [];
  for (const fixture of fixtures) {
    for (const [key, info] of added) {
      if (info.version <= fixture.version || info.guarded) continue;
      const table = key.split('.')[0]!;
      if (fixture.drops.has(key) || fixture.tables.has(table)) continue;
      gaps.push(`${fixture.file}: rolls back to ${fixture.version} but keeps ${key} (added by ${info.version})`);
    }
  }
  return gaps;
}

async function allRollbacks(): Promise<Rollback[]> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out: Rollback[] = [];
  for (const path of await testFiles(root)) {
    // This file carries synthetic fixtures as strings; scanning them would make the check fail on its own
    // examples rather than on a real fixture.
    if (path.endsWith('schema-version.test.ts')) continue;
    out.push(...rollbacks(path.slice(root.length + 1), await readFile(path, 'utf8')));
  }
  return out;
}

async function testFiles(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await testFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('a fixture that rolls the schema back drops every unguarded column added above its version', async () => {
  const source = await storeSource();
  const fixtures = await allRollbacks();
  expect(fixtures.length).toBeGreaterThan(0);
  expect(rollbackGaps(source, fixtures)).toEqual([]);
});

test('the rollback check reports a missing drop and exempts what can absorb a leftover', async () => {
  const source = [
    "if (version < 3) this.transaction(() => { this.db.exec('ALTER TABLE nodes ADD COLUMN plain TEXT;'); });",
    "if (version < 4) this.transaction(() => { const held = this.db.prepare('PRAGMA table_info(nodes)').all(); if (!held.some(c => c.name === 'guarded')) this.db.exec('ALTER TABLE nodes ADD COLUMN guarded TEXT;'); });",
    "if (version < 5) this.transaction(() => { this.db.exec('CREATE TABLE extra(id TEXT);'); });",
  ].join('\n');

  // The fixture rolls back to 2 and forgets the unguarded column v3 adds: that is the gap. A column a
  // migration only adds when it is missing, and one whose table the fixture drops, are both exempt.
  const incomplete = rollbacks('synthetic.test.ts', "db.exec('ALTER TABLE nodes DROP COLUMN gone; PRAGMA user_version=2;')");
  expect(rollbackGaps(source, incomplete)).toEqual([
    'synthetic.test.ts: rolls back to 2 but keeps nodes.plain (added by 3)',
  ]);

  // Dropping the whole table covers every column of it, guarded or not.
  const covered = rollbacks('synthetic.test.ts', "db.exec('DROP TABLE nodes; PRAGMA user_version=2;')");
  expect(rollbackGaps(source, covered)).toEqual([]);

  // A fixture that builds a legacy database from scratch drops nothing, so it is not this check's claim.
  expect(rollbacks('synthetic.test.ts', "raw.exec('CREATE TABLE nodes(task_id TEXT); PRAGMA user_version=2;')")).toEqual([]);
});
