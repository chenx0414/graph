import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { nativeGitAcceptance, git, commit } from '../fixtures/native-git-acceptance.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const fixture = (options?: Parameters<typeof nativeGitAcceptance>[1]) => nativeGitAcceptance(cleanup, options);

test('a dirty target blocks native delivery until main explicitly retries after cleanup', async () => {
  const graph = await fixture(); await graph.check(); await graph.review();
  await writeFile(join(graph.root, 'README.md'), 'human dirty edit\n'); expect((await graph.complete()).phase).toBe('blocked');
  expect(await readFile(join(graph.root, 'README.md'), 'utf8')).toBe('human dirty edit\n');
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  expect(graph.runtime.events(graph.graphId).filter(event => event.type === 'graph.delivery.pending')).toMatchObject([{ data: { detail: { kind: 'git_dirty' } } }]);
  await writeFile(join(graph.root, 'README.md'), 'project\n');
  expect((await graph.complete()).phase).toBe('completed'); expect(await readFile(join(graph.root, 'feature.txt'), 'utf8')).toBe('done');
  expect(graph.reviewer.requests).toHaveLength(3);
});

test('a target advance makes check and review receipts stale until explicit new inputs verify the new commit', async () => {
  const graph = await fixture(); await graph.check(); await graph.review(); const old = graph.disk.task(graph.graphId).integration_sha!;
  const firstReport = graph.runtime.artifacts.list(graph.graphId, { namespace: 'reviews' }).artifacts[0]!;
  await writeFile(join(graph.root, 'extra.txt'), 'from target'); git(graph.root, ['add', 'extra.txt']); commit(graph.root, 'target moved');
  expect((await graph.complete()).phase).toBe('blocked');
  const stale = (await graph.acceptance()).items; expect(stale.filter(item => item.status === 'stale').map(item => item.id).sort()).toEqual(['review', 'works']);
  expect(graph.reviewer.requests).toHaveLength(3);
  await graph.main.graphControl({ graphId: graph.graphId, action: 'withdraw_complete' }); await graph.check(); await graph.review();
  expect((await graph.complete()).phase).toBe('completed'); const latest = graph.disk.task(graph.graphId).integration_sha;
  expect(latest).not.toBe(old); expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(latest);
  expect(await readFile(join(graph.root, 'feature.txt'), 'utf8')).toBe('done'); expect(await readFile(join(graph.root, 'extra.txt'), 'utf8')).toBe('from target');
  expect(graph.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graph.graphId)).toEqual({ n: 2 });
  expect(graph.reviewer.requests).toHaveLength(6);
  expect(JSON.parse((await graph.runtime.artifacts.read(graph.graphId, firstReport.artifactId, firstReport.version)).text!).commit).toBe(old);
});

test('restore recognizes native delivery already present on the target without repeating agent or check work', async () => {
  const graph = await fixture(); await graph.check(); await graph.review(); const verified = graph.disk.task(graph.graphId).integration_sha!;
  await graph.main.graphControl({ graphId: graph.graphId, action: 'complete' }); git(graph.root, ['merge', '--ff-only', verified]);
  await graph.restart(); expect((await graph.runtime.user.task(graph.graphId).view()).phase).toBe('completed');
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(verified); expect(graph.work.requests).toHaveLength(3); expect(graph.reviewer.requests).toHaveLength(3);
  expect(graph.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graph.graphId)).toEqual({ n: 1 });
  expect(graph.disk.db.prepare('SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?').get(graph.graphId)).toEqual({ commit_sha: verified });
});

test('native human acceptance waits for a real user acknowledgement before delivery', async () => {
  const graph = await fixture({ human: true }); await graph.check(); await graph.review(); const waiting = await graph.complete();
  const question = waiting.questions.find(item => item.kind === 'human_check' && item.status === 'open')!; expect(question).toBeDefined();
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline); await expect(readFile(join(graph.root, 'feature.txt'))).rejects.toThrow();
  await graph.runtime.user.task(graph.graphId).answer(question.id, { type: 'acknowledge' }, 'accept-current-version'); await graph.runtime.host.drive();
  expect((await graph.runtime.user.task(graph.graphId).view()).phase).toBe('completed');
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.disk.task(graph.graphId).integration_sha);
  expect(graph.runtime.events(graph.graphId).filter(event => event.type === 'human.accepted')).toMatchObject([{ data: { questionId: question.id } }]);
});

test('a pending independent review cannot be replaced by successful implementation and host checks', async () => {
  const graph = await fixture(); await graph.check(); expect((await graph.complete()).phase).toBe('blocked');
  expect(graph.reviewer.requests).toHaveLength(0); expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  await graph.main.graphControl({ graphId: graph.graphId, action: 'withdraw_complete' }); await graph.review(); expect((await graph.complete()).phase).toBe('completed');
  const accepted = (await graph.acceptance()).items.find(item => item.id === 'review')!;
  expect(accepted.status).toBe('passed'); expect(accepted.source?.commit).toBe(git(graph.root, ['rev-parse', 'HEAD']));
});

test('native delivery conditionally updates an unchecked target ref while preserving the active checkout', async () => {
  const graph = await fixture({ otherBranch: true }); await graph.check(); await graph.review(); expect((await graph.complete()).phase).toBe('completed');
  const verified = graph.disk.task(graph.graphId).integration_sha!; expect(git(graph.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('other');
  expect(git(graph.root, ['rev-parse', 'other'])).toBe(graph.baseline); expect(git(graph.root, ['rev-parse', 'main'])).toBe(verified);
  await expect(readFile(join(graph.root, 'feature.txt'))).rejects.toThrow();
  expect(git(graph.root, ['show', 'main:feature.txt'])).toBe('done'); git(graph.root, ['checkout', 'main']); expect(await readFile(join(graph.root, 'feature.txt'), 'utf8')).toBe('done');
});

test('a later native worker execution makes the prior check stale without implicitly rerunning it', async () => {
  const graph = await fixture({ extraWork: [
    { tools: [{ id: 'late-write', name: 'write_file', arguments: JSON.stringify({ path: 'late.txt', content: 'extra' }) }] },
    { tools: [{ id: 'late-submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'Later integration ready' },
  ] }); await graph.check(); const old = graph.disk.task(graph.graphId).integration_sha!;
  await graph.main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'job', value: { request: 'Produce the later file' } }); await graph.runtime.host.drive();
  expect(graph.disk.task(graph.graphId).integration_sha).not.toBe(old); expect((await graph.acceptance()).items.find(item => item.id === 'works')?.status).toBe('stale');
  expect(graph.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graph.graphId)).toEqual({ n: 1 });
  await graph.check(); await graph.review(); expect((await graph.complete()).phase).toBe('completed');
  expect(await readFile(join(graph.root, 'late.txt'), 'utf8')).toBe('extra'); expect(await readFile(join(graph.root, 'feature.txt'), 'utf8')).toBe('done');
  expect(graph.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graph.graphId)).toEqual({ n: 2 });
});
