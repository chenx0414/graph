import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, Proposal } from '../../src/core/types.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup(actions: Record<string, ActionAdapter>, proposal: Proposal) {
  const root = await mkdtemp(join(tmpdir(), 'graph-m2-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: proposal.summary, requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose(proposal, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task, taskId, options };
}
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };

test('nested subgraphs route to the selected branch and export their outputs without creating container instances', async () => {
  let rejectedBranchSends = 0;
  let artifact = '';
  const { root, runtime, task } = await setup({
    route: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { selected: 'text' }, route: 'text' }) },
    text: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { format: 'text' }, usage }) },
    json: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { rejectedBranchSends++; return { outcome: 'completed', output: { format: 'json' }, usage }; } },
    join: { kind: 'program', prepare: async operation => async () => {
      expect(operation.dependencies.inner).toEqual({ text: { format: 'text' }, json: null });
      return { outcome: 'completed', output: { selected: 'text' } };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      expect(operation.dependencies.outer).toEqual({ join: { selected: 'text' } });
      await writeFile(artifact, 'text selected');
      return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'route', summary: 'Only text branch selected', artifact: { path: artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex') } }] };
    } },
  }, {
    requirementVersion: 1, summary: 'Nested routed work', acceptance: [{ id: 'route', description: 'Select correct output', checkNode: 'check' }],
    containers: [{ id: 'outer', outputs: ['join'] }, { id: 'inner', parent: 'outer', outputs: ['text', 'json'] }],
    nodes: [
      { id: 'route', kind: 'program', action: 'route', container: 'outer', routes: ['text', 'json'] },
      { id: 'text', kind: 'agent', action: 'text', definitionVersion: 'coder@1', model: 'scripted', container: 'inner', when: { node: 'route', case: 'text' } },
      { id: 'json', kind: 'agent', action: 'json', definitionVersion: 'coder@1', model: 'scripted', container: 'inner', when: { node: 'route', case: 'json' } },
      { id: 'join', kind: 'program', action: 'join', container: 'outer', dependsOn: ['inner'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['outer'] },
    ],
  });
  artifact = join(root, 'route.txt');
  for (let step = 0; step < 4; step++) expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.nodes.find(node => node.id === 'json')).toMatchObject({ status: 'skipped', used: 0 });
  expect(view.containers).toMatchObject([{ id: 'outer', status: 'succeeded', output: { join: { selected: 'text' } } }, { id: 'inner', status: 'succeeded' }]);
  expect(view.nodes.filter(node => node.instanceId)).toHaveLength(2);
  expect(rejectedBranchSends).toBe(0);
});

test('required failures block only their join, optional failures may be absent, and retry reuses the successful sibling', async () => {
  let attempts = 0; let siblingRuns = 0; let artifact = '';
  const { root, runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: ++attempts === 1 ? 'failed' : 'completed', output: { attempt: attempts }, usage }) },
    sibling: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { siblingRuns++; return { outcome: 'completed', output: { stable: true }, usage }; } },
    optional: { kind: 'program', prepare: async () => async () => ({ outcome: 'failed', output: { reason: 'Optional source unavailable' } }) },
    check: { kind: 'program', prepare: async operation => async () => {
      expect(operation.dependencies.sibling).toEqual({ stable: true });
      await writeFile(artifact, 'joined');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'join', summary: 'Both required branches joined', artifact: { path: artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex') } }] };
    } },
  }, { requirementVersion: 1, summary: 'Join required work', acceptance: [{ id: 'join', description: 'Required work succeeds', checkNode: 'check' }], nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'sibling', kind: 'agent', action: 'sibling', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'optional', kind: 'program', action: 'optional', optional: true },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'sibling', 'optional'] },
  ] });
  artifact = join(root, 'joined.txt');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 3 });
  const failed = await task.view();
  expect(failed.questions).toMatchObject([{ nodeId: 'work', kind: 'execution_failed' }]);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  await task.answer(failed.questions[0]!.id, { type: 'retry' }, 'retry');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const completed = await task.view();
  expect(completed.phase).toBe('completed');
  expect(completed.nodes[0]).toMatchObject({ instanceId: failed.nodes[0]!.instanceId, used: 100 });
  expect(siblingRuns).toBe(1);
});

test('a downstream check receives the persisted activation and artifact versions that produced its input', async () => {
  let artifact = ''; let producerActivation = '';
  const { root, runtime, task, taskId, options } = await setup({
    produce: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      producerActivation = operation.activationId;
      await writeFile(artifact, 'versioned result');
      return { outcome: 'completed', output: { artifact }, usage, artifacts: [{ id: 'result', path: artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex') }] };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      expect(operation.dependencySources.produce).toMatchObject([{ activationId: producerActivation, outputVersion: 1, artifacts: [{ id: 'result', activationId: producerActivation, nodeId: 'produce', path: artifact }] }]);
      const version = operation.dependencySources.produce![0]!.artifacts[0]!;
      expect(version.operationId).toBe(operation.dependencySources.produce![0]!.operationId);
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'version', summary: 'Checked exact producer artifact', artifact: { path: artifact, digest: version.digest } }] };
    } },
  }, { requirementVersion: 1, summary: 'Versioned handoff', acceptance: [{ id: 'version', description: 'Check exact input', checkNode: 'check' }], nodes: [
    { id: 'produce', kind: 'agent', action: 'produce', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['produce'] },
  ] });
  artifact = join(root, 'artifact.txt');
  await runtime.host.runReady();
  const before = await task.view();
  expect(before.nodes[0]).toMatchObject({ activationId: expect.any(String), outputVersion: 1 });
  expect(before.operations[0]).toMatchObject({ activationId: before.nodes[0]!.activationId, graphVersion: 1 });
  await runtime.close();
  const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  await restored.host.runReady();
  const completed = await restored.user.task(taskId).view();
  expect(completed.phase).toBe('completed');
  expect(completed.evidence[0]).toMatchObject({ activationId: completed.nodes[1]!.activationId, valid: true });
});

test('a verifier gate can sit outside a nested container and still consume descendant artifacts', async () => {
  const config = { kind: 'multiview' as const, subjectNode: 'produce', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  let artifact = '';
  const { root, runtime, task } = await setup({
    produce: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      await writeFile(artifact, 'nested');
      return { outcome: 'completed', output: { nested: true }, usage, artifacts: [{ id: 'result', path: artifact, digest: createHash('sha256').update('nested').digest('hex') }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const subject = operation.dependencySources.produce![0]!.artifacts[0]!;
      return { outcome: 'completed', output: { schemaVersion: 1, subject, body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'Nested output matches', evidence: [subject] } } } } as unknown as Json, usage };
    } },
  }, {
    requirementVersion: 1, summary: 'Nested verifier',
    acceptance: [{ id: 'version', description: 'Nested check', checkNode: 'gate' }],
    containers: [{ id: 'inner', outputs: ['produce', 'review'] }],
    nodes: [
      { id: 'produce', kind: 'agent', action: 'produce', definitionVersion: 'coder@1', model: 'scripted', container: 'inner' },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'coder@1', model: 'scripted', container: 'inner', dependsOn: ['produce'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['produce', 'review'], verifier: config },
    ],
  });
  artifact = join(root, 'artifact.txt');
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
});
