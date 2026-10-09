import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { combined, git, nativeGitConflict } from '../fixtures/native-git-conflict.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const fixture = () => nativeGitConflict(cleanup);

test('an explicit two-parent conflict resolution passes the declared native check and delivers both contributions', async () => {
  const graph = await fixture(); await graph.collide(); const sha = await graph.resolve(combined);
  const parents = git(graph.project, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/); expect(parents).toHaveLength(3);
  expect(await graph.check()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'preserved', status: 'passed', source: expect.objectContaining({ commit: sha }) })]) });
  await graph.review(); expect((await graph.finish()).phase).toBe('completed'); expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(sha);
  expect(await readFile(join(graph.project, 'shared.txt'), 'utf8')).toBe(combined);
}, 30000);

for (const candidate of [
  { name: 'drops one contribution', content: 'a\nfrom-main\nc\n' },
  { name: 'changes an unrelated file', content: combined, other: 'unapproved rewrite\n' },
  { name: 'leaves conflict markers', content: 'a\n<<<<<<< HEAD\nfrom-main\n=======\nfrom-lane\n>>>>>>> lane\nc\n' },
]) test(`a committed resolution that ${candidate.name} fails its native acceptance check and cannot reach target`, async () => {
  const graph = await fixture(); await graph.collide(); const sha = await graph.resolve(candidate.content, candidate.other);
  expect(git(graph.integrationTree, ['rev-parse', 'HEAD'])).toBe(sha);
  expect(await graph.check()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'preserved', status: 'failed' })]) });
  expect((await graph.finish()).phase).toBe('blocked'); expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  // Keep the rejected committed candidate for main to inspect; do not pretend it never existed.
  expect(git(graph.trees.b, ['show', `${sha}:shared.txt`])).toBe(candidate.content.trim());
}, 30000);

test('a missing lane ref fails Git integration without modifying the previous integration commit or target', async () => {
  const graph = await fixture(); await graph.collide(); const before = git(graph.integrationTree, ['rev-parse', 'HEAD']);
  // An external Git action changes a real ref, not a fabricated database result.
  git(graph.trees.b, ['branch', '-m', 'renamed-by-main']);
  expect(graph.integrate('b')).toMatchObject({ ok: false });
  expect(git(graph.integrationTree, ['rev-parse', 'HEAD'])).toBe(before);
  expect(git(graph.integrationTree, ['status', '--porcelain'])).toBe('');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);

test('noncolliding lanes integrate without a resolver and leave a genuine clean two-parent merge', async () => {
  const graph = await fixture(); await writeFile(join(graph.trees.a, 'a.txt'), 'left\n'); await writeFile(join(graph.trees.b, 'b.txt'), 'right\n');
  expect(graph.integrate('a')?.ok).toBe(true); expect(graph.integrate('b')?.ok).toBe(true);
  expect(git(graph.integrationTree, ['show', 'HEAD:a.txt'])).toBe('left'); expect(git(graph.integrationTree, ['show', 'HEAD:b.txt'])).toBe('right');
  expect(git(graph.integrationTree, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/)).toHaveLength(3);
  expect(git(graph.integrationTree, ['status', '--porcelain'])).toBe('');
  expect(graph.runtime.events(graph.graphId).filter(event => event.type.startsWith('git.conflict.merge_attempt'))).toHaveLength(0);
}, 30000);

test('changing a verified conflict resolution commit makes the previous native receipt stale until an explicit new check', async () => {
  const graph = await fixture(); await graph.collide(); const reviewed = await graph.resolve(combined); await graph.check();
  await writeFile(join(graph.trees.b, 'shared.txt'), 'a\nfrom-main\nc\n'); expect(graph.integrate('b')?.ok).toBe(true);
  const current = graph.disk.task(graph.graphId).integration_sha; expect(current).not.toBe(reviewed);
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'preserved', status: 'stale' })]) });
  const operations = await graph.main.graphInspect({ graphId: graph.graphId, query: 'operations' }) as { result: { outputs: { result: { verifiedCommit: string } } } }[];
  expect(operations).toHaveLength(1); expect(operations[0]!.result.outputs.result.verifiedCommit).toBe(reviewed);
  expect((await graph.finish()).phase).toBe('blocked'); expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  await graph.main.graphControl({ graphId: graph.graphId, action: 'withdraw_complete' });
  expect(await graph.check()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'preserved', status: 'failed' })]) });
}, 30000);
