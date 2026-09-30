import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git as runGit } from '../../src/git/git.ts';
import { deployDrift, developmentCandidates } from '../../src/runtime/deploy-drift.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function shell(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A checkout of the same repository, next to `parent` so the two are siblings. */
async function checkout(parent: string, name: string, origin: string, files: Record<string, string>) {
  const root = join(parent, name);
  await mkdir(join(root, 'src'), { recursive: true });
  shell(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), '# graph\n');
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  shell(root, ['remote', 'add', 'origin', origin]);
  return root;
}

async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), 'graph-drift-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

test('drift names what differs, what is missing and what only this checkout has', async () => {
  const parent = await workspace();
  const origin = 'https://example.invalid/graph-drift.git';
  const deployed = await checkout(parent, 'deployed', origin, { 'src/keep.ts': 'export const value = 1;\n' });
  const development = await checkout(parent, 'development', origin, { 'src/keep.ts': 'export const value = 1;\n' });

  // Which side has to change is what a reader acts on, so the three cases stay apart.
  await writeFile(join(development, 'src', 'keep.ts'), 'export const value = 2;\n');
  await writeFile(join(development, 'tests-added.ts'), '// on the development line only\n');
  shell(development, ['add', '-A']);
  shell(development, ['commit', '-m', 'development moves on']);
  await writeFile(join(deployed, 'src', 'deployed-only.ts'), 'export const local = true;\n');
  shell(deployed, ['add', '-A']);
  shell(deployed, ['commit', '-m', 'deployed-side work']);

  const drift = deployDrift(deployed, development);
  expect(drift).toMatchObject({
    root: development,
    files: ['src/keep.ts'],
    missing: ['tests-added.ts'],
    extra: ['src/deployed-only.ts'],
    runtimeFiles: ['src/deployed-only.ts', 'src/keep.ts'],
  });
  expect(drift.note).toContain('development');
  expect(drift.note).toContain('src/keep.ts');
});

test('two checkouts that agree say so instead of staying silent', async () => {
  const parent = await workspace();
  const origin = 'https://example.invalid/graph-drift.git';
  const files = { 'src/keep.ts': 'export const value = 1;\n' };
  const deployed = await checkout(parent, 'deployed', origin, files);
  const development = await checkout(parent, 'development', origin, files);

  const drift = deployDrift(deployed, development);
  expect(drift).toMatchObject({ files: [], missing: [], extra: [], runtimeFiles: [] });
  expect(drift.note).toContain('一致');
});

test('the comparison never writes to either checkout', async () => {
  const parent = await workspace();
  const origin = 'https://example.invalid/graph-drift.git';
  const deployed = await checkout(parent, 'deployed', origin, { 'src/keep.ts': 'export const value = 1;\n' });
  const development = await checkout(parent, 'development', origin, { 'src/keep.ts': 'export const value = 9;\n' });

  // A read that refreshes an index is a write, and this runs inside a status route: the index bytes of
  // both checkouts have to survive it untouched.
  const before = [join(deployed, '.git', 'index'), join(development, '.git', 'index')].map(path => readFileSync(path));
  expect(deployDrift(deployed, development).files).toEqual(['src/keep.ts']);
  const after = [join(deployed, '.git', 'index'), join(development, '.git', 'index')].map(path => readFileSync(path));
  expect(after.map(buffer => buffer.toString('base64'))).toEqual(before.map(buffer => buffer.toString('base64')));
});

test('a checkout that is a worktree is still recognised', async () => {
  const parent = await workspace();
  const origin = 'https://example.invalid/graph-drift.git';
  const main = await checkout(parent, 'main-checkout', origin, { 'src/keep.ts': 'export const value = 1;\n' });
  // The deployed checkout is a worktree of the main one: its .git is a file, and its config lives in
  // the common git directory its gitdir points at.
  const deployed = join(parent, 'worktree');
  shell(main, ['worktree', 'add', deployed]);
  await writeFile(join(main, 'src', 'keep.ts'), 'export const value = 2;\n');
  shell(main, ['add', '-A']);
  shell(main, ['commit', '-m', 'the development line moves on']);

  expect(developmentCandidates(deployed, {})).toEqual([main]);
  expect(deployDrift(deployed, main).files).toEqual(['src/keep.ts']);
});

test('candidates are the same repository next to this checkout, or the configured one', async () => {
  const parent = await workspace();
  const origin = 'https://example.invalid/graph-drift.git';
  const deployed = await checkout(parent, 'deployed', origin, { 'src/keep.ts': 'export const value = 1;\n' });
  const development = await checkout(parent, 'development', origin, { 'src/keep.ts': 'export const value = 1;\n' });
  // Another checkout of a different repository is not a candidate, however close it sits.
  await checkout(parent, 'other', 'https://example.invalid/other.git', { 'src/other.ts': 'export const other = 1;\n' });

  expect(developmentCandidates(deployed, {})).toEqual([development]);

  // An explicit root wins, so a setup the sibling rule cannot see still works.
  expect(developmentCandidates(deployed, { GRAPH_DEVELOPMENT_ROOT: join(parent, 'other') })).toEqual([join(parent, 'other')]);
});
