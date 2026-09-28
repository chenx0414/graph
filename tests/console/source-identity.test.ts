import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readSourceIdentity, shortCommit } from '../../src/server/source-identity.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-source-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A checkout that looks like a Graph source run: a package.json at the top of a git repository. */
async function checkout(name: string) {
  const dir = await temp(name);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'graph' }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'graph@example.invalid']);
  git(dir, ['config', 'user.name', 'Graph Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('a source checkout reports the commit and branch the running code came from', async () => {
  const dir = await checkout('clean');
  const identity = readSourceIdentity(dir);
  expect(identity.root).toBe(dir);
  expect(identity.commit).toBe(git(dir, ['rev-parse', 'HEAD']));
  expect(identity.branch).toBe('main');
  expect(identity.dirty).toBe(false);
  expect(shortCommit(identity)).toBe(identity.commit!.slice(0, 12));
});

test('uncommitted changes are reported, because they are the case where a commit number misleads', async () => {
  const dir = await checkout('dirty');
  await writeFile(join(dir, 'extra.ts'), 'export const x = 1;\n');
  const identity = readSourceIdentity(dir);
  expect(identity.dirty).toBe(true);
  // The commit is still the last commit; that is the point - the number alone would look clean.
  expect(identity.commit).toBe(git(dir, ['rev-parse', 'HEAD']));
});

test('a detached head reports no branch instead of the literal HEAD', async () => {
  const dir = await checkout('detached');
  git(dir, ['checkout', '-q', '--detach', 'HEAD']);
  expect(readSourceIdentity(dir).branch).toBeNull();
});

test('a directory that is not a checkout is unknown, never invented', async () => {
  const dir = await temp('plain');
  await mkdir(join(dir, 'nested'), { recursive: true });
  const identity = readSourceIdentity(dir);
  expect(identity).toEqual({ root: dir, commit: null, branch: null, dirty: null });
  expect(shortCommit(identity)).toBe('未知');
});

test('a packaged app root has a package.json but no git, and says so instead of guessing', async () => {
  const dir = await temp('packaged');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'graph' }));
  const identity = readSourceIdentity(dir);
  expect(identity.commit).toBeNull();
  expect(identity.branch).toBeNull();
  expect(identity.dirty).toBeNull();
});
