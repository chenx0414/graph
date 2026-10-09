import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { GitIntegration } from '../../src/git/integration.ts';
import { nativeGitAcceptance, git, commit } from '../fixtures/native-git-acceptance.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const fixture = (options?: Parameters<typeof nativeGitAcceptance>[1]) => nativeGitAcceptance(cleanup, options);

test('a native Git work-check graph without an independent reviewer cannot deliver', async () => {
  const graph = await fixture({ review: 'none' }); await graph.check(); const view = await graph.complete();
  expect(view.phase).toBe('blocked'); await expect(graph.acceptance()).resolves.toMatchObject({ items: [{ id: 'independent-review', status: 'missing' }, { id: 'works', status: 'passed' }] });
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline); await expect(readFile(join(graph.root, 'feature.txt'))).rejects.toThrow();
});

test('a completed native reviewer without a published review cannot deliver', async () => {
  const graph = await fixture({ review: 'missing' }); await graph.check(); await graph.review();
  expect(graph.runtime.nodeRun(graph.graphId, 'review').node.status).toBe('succeeded');
  expect((await graph.complete()).phase).toBe('blocked'); expect((await graph.acceptance()).items.find(item => item.id === 'review')?.status).toBe('missing');
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
});

test('a published failing independent review preserves its exact reason and prevents delivery', async () => {
  const graph = await fixture({ review: 'failed' }); await graph.check(); await graph.review(); expect((await graph.complete()).phase).toBe('blocked');
  expect((await graph.acceptance()).items.find(item => item.id === 'review')).toMatchObject({ status: 'failed', reason: 'copy button still shows text' });
  const report = graph.runtime.artifacts.list(graph.graphId, { namespace: 'reviews' }).artifacts[0]!;
  expect(JSON.parse((await graph.runtime.artifacts.read(graph.graphId, report.artifactId, report.version)).text!)).toMatchObject({ passed: false, reason: 'copy button still shows text', commit: graph.disk.task(graph.graphId).integration_sha });
  expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
});

test('native review model exclusion traverses the host-check module and disabled structural edges', async () => {
  const graph = await fixture({ sameModel: true }); await graph.check(); await graph.review();
  expect(graph.reviewer.requests).toHaveLength(0); expect(graph.work.requests).toHaveLength(3);
  expect(graph.runtime.events(graph.graphId).filter(event => event.type === 'graph.node.blocked')).toMatchObject([{ data: { reason: expect.stringContaining('No eligible configured model') } }]);
  expect((await graph.complete()).phase).toBe('blocked'); expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
});

test('native delivery preserves a dirty target checkout in another worktree', async () => {
  const graph = await fixture({ alternateTarget: true }); await graph.check(); await graph.review(); expect((await graph.complete()).phase).toBe('blocked');
  expect(graph.runtime.events(graph.graphId).filter(event => event.type === 'graph.delivery.pending')).toMatchObject([{ data: { status: 'blocked', detail: { kind: 'git_dirty' } } }]);
  expect(await readFile(join(graph.target, 'README.md'), 'utf8')).toBe('human dirty edit\n'); expect(git(graph.target, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  await expect(readFile(join(graph.target, 'feature.txt'))).rejects.toThrow();
});

test('human rejection keeps native acceptance blocked and sends main the actual rework reason', async () => {
  const graph = await fixture({ human: true }); await graph.check(); await graph.review(); const view = await graph.complete();
  const question = view.questions.find(q => q.kind === 'human_check' && q.status === 'open')!; expect(question).toBeDefined();
  await graph.runtime.user.task(graph.graphId).answer(question.id, { type: 'reject', reason: 'copy button still shows text' }, 'reject'); await graph.runtime.host.drive();
  const after = await graph.runtime.user.task(graph.graphId).view(); expect(after.phase).toBe('blocked');
  expect(after.questions.find(q => q.kind === 'rework' && q.status === 'open')?.data).toMatchObject({ reason: 'copy button still shows text' });
  expect((await graph.acceptance()).items.find(item => item.id === 'human')?.status).not.toBe('passed'); expect(git(graph.root, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
});

test('a native human approval cannot accept the next integration version after the target advances', async () => {
  const graph = await fixture({ human: true }); await graph.check(); await graph.review(); const view = await graph.complete();
  const question = view.questions.find(q => q.kind === 'human_check' && q.status === 'open')!;
  await writeFile(join(graph.root, 'target.txt'), 'target moved after inspection'); git(graph.root, ['add', 'target.txt']); commit(graph.root, 'advance target');
  await graph.runtime.user.task(graph.graphId).answer(question.id, { type: 'acknowledge' }, 'old-approval'); await graph.runtime.host.drive();
  expect((await graph.runtime.user.task(graph.graphId).view()).phase).toBe('blocked');
  expect((await graph.acceptance()).items.find(item => item.id === 'human')?.status).toBe('missing');
  await graph.main.graphControl({ graphId: graph.graphId, action: 'withdraw_complete' }); await graph.check(); await graph.review(); const next = await graph.complete();
  const again = next.questions.filter(q => q.kind === 'human_check' && q.status === 'open'); expect(again).toHaveLength(1); expect(again[0]!.id).not.toBe(question.id);
  expect(again[0]!.data).toMatchObject({ commitSha: graph.disk.task(graph.graphId).integration_sha });
});

test('unknown native review usage remains held when a later target integration needs rechecking', async () => {
  const graph = await fixture({ review: 'unknown' }); await graph.check(); await graph.review(); const before = graph.runtime.nodeRun(graph.graphId, 'review');
  expect(before.invocations.some(call => call.usageSource === 'unknown')).toBe(true); expect(graph.reviewer.requests).toHaveLength(1);
  const previous = graph.disk.task(graph.graphId).integration_sha!; await writeFile(join(graph.root, 'late.txt'), 'late'); git(graph.root, ['add', 'late.txt']); commit(graph.root, 'late target');
  expect(new GitIntegration(graph.disk, graph.stateDir).tryDeliver(graph.graphId, previous).status).toBe('recheck');
  await graph.main.graphSend({ graphId: graph.graphId, nodeId: 'review', input: 'job', value: {} }); await graph.runtime.host.drive();
  expect(graph.reviewer.requests).toHaveLength(1); expect(graph.runtime.nodeRun(graph.graphId, 'review').invocations.filter(call => call.usageSource === 'unknown')).toHaveLength(1);
  expect((await graph.complete()).phase).toBe('blocked'); expect(git(graph.root, ['show', 'main:late.txt'])).toBe('late');
});
