import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The background confirmation after a reload checks the commit out into a
 * throwaway worktree. That worktree is removed by the goroutine that made it,
 * so a run killed by the next reload leaves a registered worktree and a whole
 * checkout behind for ever - nothing ever looks at them again.
 *
 * The proof is the real daemon and real git: a stale snapshot disappears when
 * the daemon opens the source checkout, and a fresh one - the one a run in
 * flight would own - is left alone.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

test('opening the source checkout removes the snapshots an interrupted confirmation left behind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'graph-prune-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'graph', version: '0.0.0' }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.']);
  git(repo, ['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-qm', 'initial']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  // Two snapshots: one a killed run left days ago, one a run in flight would
  // hold right now. The path shape is the one rsiSnapshotRoot creates.
  const stale = join(home, 'graph-async-full-stale');
  const fresh = join(home, 'graph-async-full-fresh');
  git(repo, ['worktree', 'add', '--detach', stale, head]);
  git(repo, ['worktree', 'add', '--detach', fresh, head]);
  const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(stale, daysAgo, daysAgo);
  expect(git(repo, ['worktree', 'list'])).toContain(stale);
  expect(git(repo, ['worktree', 'list'])).toContain(fresh);

  const stateDir = join(home, 'state');
  await mkdir(join(stateDir, 'conversations'), { recursive: true });
  const webDir = join(home, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const daemon = await launchCli(home, { stateDir, webDir, env: { GRAPH_RSI_ROOT: repo } });
  cleanup.push(() => daemon.close());

  // The daemon opened the checkout as its self-improvement root and the
  // snapshot the interrupted run left is gone, registration and all.
  const listed = git(repo, ['worktree', 'list']);
  expect(listed).not.toContain(stale);
  await expect(stat(stale)).rejects.toThrow();

  // A recent snapshot is left for the run that may still be using it.
  expect(listed).toContain(fresh);
  await stat(fresh);
}, 120_000);
