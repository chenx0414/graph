import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec, Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const coder = { definitionVersion: 'coder@1', model: 'scripted' };

async function setup(actions: Record<string, ActionAdapter>, nodes: NodeSpec[], extra: Partial<Proposal> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-revision-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Revise the graph', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Revise the graph',
    acceptance: extra.acceptance ?? [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes, ...extra,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task, taskId, options, supervisor: runtime.supervisor(taskId) };
}

test('a supervisor revision keeps instances, rejects a stale base, and cannot weaken required work', async () => {
  const { runtime, task, supervisor, root } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { ready: true }, usage }) },
    extra: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { extra: true }, usage }) },
    check: { kind: 'program', prepare: async () => async () => {
      const path = join(root, 'ok.txt'); await writeFile(path, 'ok');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'Checked', artifact: { path, digest: createHash('sha256').update('ok').digest('hex') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', ...coder },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  const before = await task.view();
  const nodes: NodeSpec[] = [
    { id: 'work', kind: 'agent', action: 'work', ...coder },
    { id: 'extra', kind: 'agent', action: 'extra', ...coder },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'extra'] },
  ];
  await expect(supervisor.revise({ baseVersion: 0, reason: 'Stale', nodes, requestId: 'stale' })).rejects.toMatchObject({ code: 'stale_graph' });
  await expect(supervisor.revise({ baseVersion: 1, reason: 'Weaken', nodes: [{ id: 'work', kind: 'agent', action: 'work', ...coder, optional: true }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] }], requestId: 'optional' })).rejects.toMatchObject({ code: 'invalid_proposal' });
  const revised = await supervisor.revise({ baseVersion: 1, reason: 'Add a sibling after the first branch finished', nodes, requestId: 'add' });
  expect(revised.graphVersion).toBe(2);
  const mid = await task.view();
  expect(mid.graphVersion).toBe(2);
  expect(mid.phase).toBe('running');
  expect(mid.nodes.find(node => node.id === 'work')).toMatchObject({ instanceId: before.nodes.find(node => node.id === 'work')?.instanceId, status: 'succeeded' });
  expect(mid.nodes.find(node => node.id === 'check')?.status).toBe('pending');
  expect(mid.evidence.some(item => !item.valid)).toBe(true);
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect((await task.view()).nodes.find(node => node.id === 'extra')?.status).toBe('succeeded');
  expect((await task.view()).evidence.filter(item => item.valid)).toHaveLength(1);
});

test('a revision cannot weaken a confirmed required verification dimension', async () => {
  const verifier = { kind: 'multiview' as const, subjectNode: 'work', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const nodes: NodeSpec[] = [
    { id: 'work', kind: 'agent', action: 'work', ...coder },
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['work'] },
    { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier },
  ];
  const { supervisor } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
    review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
  }, nodes, { acceptance: [{ id: 'works', description: 'Required correctness passes', checkNode: 'gate' }] });
  const weakened = nodes.map(node => node.id === 'gate'
    ? { ...node, verifier: { ...verifier, dimensions: [{ id: 'correctness', required: false, reportNode: 'review' }] } }
    : node);
  await expect(supervisor.revise({ baseVersion: 1, reason: 'Treat correctness as a suggestion', nodes: weakened, requestId: 'weaken' }))
    .rejects.toMatchObject({ code: 'invalid_proposal' });
});

test('exhausted incomplete work cannot disappear by deletion or a new instance', async () => {
  const { runtime, task, supervisor } = await setup({
    work: { kind: 'agent', reserveTokens: 20_000_000, prepare: async () => async () => ({ outcome: 'continue', output: null, usage: { input: 19_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null }) },
  }, [
    { id: 'work', kind: 'agent', action: 'work', ...coder },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await runtime.host.runReady();
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  const blocked = await task.view();
  expect(blocked.questions).toMatchObject([{ kind: 'budget' }]);
  await expect(supervisor.revise({
    baseVersion: 1, reason: 'Drop exhausted work', requestId: 'drop',
    nodes: [{ id: 'replacement', kind: 'agent', action: 'work', ...coder }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['replacement'] }],
  })).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect((await task.view()).nodes.find(node => node.id === 'work')).toMatchObject({ instanceId: blocked.nodes[0]!.instanceId, used: 20_000_000, status: 'blocked' });
  await expect(task.resume('resume')).resolves.toMatchObject({ taskId: blocked.id });
  expect((await task.view()).questions.some(question => question.kind === 'budget' && question.status === 'open')).toBe(true);
});
