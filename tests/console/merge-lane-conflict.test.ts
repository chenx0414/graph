import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git, nativeGitConflict } from '../fixtures/native-git-conflict.ts';
import { mergeConflictFiles } from '../../src/git/git.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('native lane integration retains earlier disjoint work and its exact metadata when a later same-line merge fails', async () => {
  const graph = await nativeGitConflict(cleanup);
  await writeFile(join(graph.trees.a, 'only-a.txt'), 'a\n'); await writeFile(join(graph.trees.b, 'only-b.txt'), 'b\n');
  expect(graph.integrate('a')?.ok).toBe(true); expect(graph.integrate('b')?.ok).toBe(true);
  const merged = graph.disk.task(graph.graphId).integration_sha;
  expect(git(graph.integrationTree, ['show', `${merged}:only-a.txt`])).toBe('a');
  expect(git(graph.integrationTree, ['show', `${merged}:only-b.txt`])).toBe('b');
  const prior = await graph.collide();
  expect(graph.disk.task(graph.graphId).integration_sha).toBe(prior);
  expect(git(graph.integrationTree, ['show', 'HEAD:only-a.txt'])).toBe('a'); expect(git(graph.integrationTree, ['show', 'HEAD:only-b.txt'])).toBe('b');
  expect(mergeConflictFiles(graph.integrationTree)).toEqual([]);
  expect(git(graph.integrationTree, ['status', '--porcelain'])).toBe('');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);

test('publishing a literal-path code commit keeps unrelated staged changes out of that stable version', async () => {
  const graph = await nativeGitConflict(cleanup); const workspace = graph.trees.a;
  await writeFile(join(workspace, '*.txt'), 'literal filename\n'); await writeFile(join(workspace, 'other.txt'), 'pending unrelated change\n');
  git(workspace, ['add', 'other.txt']);
  const version = graph.integration.commitWorkspace({ id: 'publish-code', taskId: graph.graphId, nodeId: 'a', instanceId: graph.instance('a'), recipe: 'coder@1',
    workspace, paths: ['*.txt'], message: 'Publish only the literal named file' });
  expect(git(workspace, ['show', `${version.commit}:*.txt`])).toBe('literal filename');
  expect(git(workspace, ['show', `${version.commit}:other.txt`])).toBe('untouched');
  expect(await readFile(join(workspace, 'other.txt'), 'utf8')).toBe('pending unrelated change\n');
  expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('other.txt');
  expect(git(workspace, ['log', '-1', '--format=%an'])).toBe('Code author');
  // A later explicit integration includes the next code version; the old published commit stays immutable.
  expect(graph.integrate('a')?.ok).toBe(true);
  expect(git(graph.integrationTree, ['show', 'HEAD:other.txt'])).toBe('pending unrelated change');
  expect(git(workspace, ['show', `${version.commit}:other.txt`])).toBe('untouched');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);
