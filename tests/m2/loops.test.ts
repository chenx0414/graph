import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, Proposal } from '../../src/core/types.ts';
import type { ReviewReport, VerifierConfig } from '../../src/core/verification.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const json = (value: unknown): Json => value as Json;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const coder = { definitionVersion: 'coder@1', model: 'scripted' };

async function setup(actions: Record<string, ActionAdapter>, proposal: Proposal) {
  const root = await mkdtemp(join(tmpdir(), 'graph-loops-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: proposal.summary, requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose(proposal, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task, taskId, options };
}

test('rework reactivates the original instance, invalidates old evidence, and reuses an unchanged sibling', async () => {
  let implementations = 0; let siblingRuns = 0; let reviews = 0;
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'work', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const { root, runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      implementations++;
      const path = join(root, 'work.txt');
      await writeFile(path, `version ${implementations}`);
      return { outcome: 'completed', output: { version: implementations }, usage, artifacts: [{ id: 'work', path, digest: digest(`version ${implementations}`) }] };
    } },
    sibling: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { siblingRuns++; return { outcome: 'completed', output: { stable: true }, usage }; } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      reviews++;
      const artifact = operation.dependencySources.work![0]!.artifacts[0]!;
      const verdict = artifact.digest === digest('version 1') ? 'fail' : 'pass';
      const report: ReviewReport = { schemaVersion: 1, subject: artifact,
        body: { kind: 'multiview', dimensions: { correctness: { verdict, reason: verdict === 'pass' ? 'Matches the required result' : 'First attempt is incomplete', evidence: [artifact] } } } };
      return { outcome: 'completed', output: json(report), usage };
    } },
  }, {
    requirementVersion: 1, summary: 'Rework the original node',
    acceptance: [{ id: 'works', description: 'Required review passes', checkNode: 'gate' }],
    loops: [{ from: 'gate', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', ...coder },
      { id: 'sibling', kind: 'agent', action: 'sibling', ...coder },
      { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['work'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier: config },
    ],
  });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(implementations).toBe(2);
  expect(reviews).toBe(2);
  expect(siblingRuns).toBe(1);
  const work = view.nodes.find(node => node.id === 'work');
  expect(work).toMatchObject({ outputVersion: 2, stallCount: 0 });
  expect(view.operations.filter(operation => operation.nodeId === 'work').every(operation => operation.instanceId === work?.instanceId)).toBe(true);
  expect(view.evidence.filter(item => item.valid)).toHaveLength(1);
  expect(view.operations.filter(operation => operation.nodeId === 'gate')[0]?.result?.output).toMatchObject({ outcome: 'rework' });
  expect(view.operations.filter(operation => operation.nodeId === 'gate')).toHaveLength(2);
  const firstGate = view.operations.find(operation => operation.nodeId === 'gate')!;
  const secondInputs = view.operations.filter(operation => operation.nodeId === 'gate')[1]!.inputVersions.work;
  expect(secondInputs).not.toEqual(firstGate.inputVersions.work);
});

test('old-round success cannot satisfy a join after the producer is reactivated', async () => {
  let checkVersions: number[] = [];
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'work', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const { root, runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const version = operation.attempt;
      const path = join(root, 'work.txt');
      await writeFile(path, `v${version}`);
      return { outcome: 'completed', output: { version }, usage, artifacts: [{ id: 'work', path, digest: digest(`v${version}`) }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const artifact = operation.dependencySources.work![0]!.artifacts[0]!;
      const version = (operation.dependencies.work as { version: number }).version;
      const report: ReviewReport = { schemaVersion: 1, subject: artifact,
        body: { kind: 'multiview', dimensions: { correctness: { verdict: version === 1 ? 'fail' : 'pass', reason: 'Attempt review', evidence: [artifact] } } } };
      return { outcome: 'completed', output: json(report), usage };
    } },
  }, {
    requirementVersion: 1, summary: 'New inputs need a new check',
    acceptance: [{ id: 'works', description: 'Current artifact passes', checkNode: 'gate' }],
    loops: [{ from: 'gate', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', ...coder },
      { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['work'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier: config },
    ],
  });
  await runtime.host.drive();
  const view = await task.view();
  const gates = view.operations.filter(operation => operation.nodeId === 'gate');
  expect(gates).toHaveLength(2);
  checkVersions = gates.map(operation => operation.inputVersions.work![0]!.outputVersion);
  expect(checkVersions[1]).toBeGreaterThan(checkVersions[0]!);
  expect(view.phase).toBe('completed');
  expect(await readFile(join(root, 'work.txt'), 'utf8')).toBe('v2');
});

test('a rework in progress survives process restart and still reuses the original instance', async () => {
  let implementations = 0; let workRoot = '';
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'work', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const { root, runtime, task, taskId, options } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      implementations++;
      const path = join(workRoot, 'work.txt');
      await writeFile(path, `version ${implementations}`);
      return { outcome: 'completed', output: { version: implementations }, usage, artifacts: [{ id: 'work', path, digest: digest(`version ${implementations}`) }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const artifact = operation.dependencySources.work![0]!.artifacts[0]!;
      const version = (operation.dependencies.work as { version: number }).version;
      const report: ReviewReport = { schemaVersion: 1, subject: artifact,
        body: { kind: 'multiview', dimensions: { correctness: { verdict: version === 1 ? 'fail' : 'pass', reason: 'Review', evidence: [artifact] } } } };
      return { outcome: 'completed', output: json(report), usage };
    } },
  }, {
    requirementVersion: 1, summary: 'Recover rework',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'gate' }],
    loops: [{ from: 'gate', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', ...coder },
      { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['work'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier: config },
    ],
  });
  workRoot = root;
  await runtime.host.runReady();
  await runtime.host.runReady();
  await runtime.host.runReady();
  const before = await task.view();
  expect(before.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ outcome: 'rework' });
  const instanceId = before.nodes.find(node => node.id === 'work')?.instanceId;
  await runtime.close();
  const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  await restored.host.drive();
  const completed = await restored.user.task(taskId).view();
  expect(completed.phase).toBe('completed');
  expect(completed.nodes.find(node => node.id === 'work')?.instanceId).toBe(instanceId);
  expect(implementations).toBe(2);
});


test('full access does not repeatedly dispatch a program that throws during settlement or execution', async () => {
  const { options, runtime, taskId } = await setup({
    check: { kind: 'program', prepare: async () => async () => { throw new Error('column index out of range'); } },
  }, {
    requirementVersion: 1, summary: 'Do not spin on a program failure',
    acceptance: [{ id: 'works', description: 'Check passes', checkNode: 'check' }],
    nodes: [{ id: 'check', kind: 'program', action: 'check' }],
  });
  await runtime.close();
  const full = await openTaskRuntime({ ...options, access: () => fullAccessPolicy() });
  cleanup.push(() => full.close());
  for (let tick = 0; tick < 3; tick++) await full.host.runReady();
  const view = await full.user.task(taskId).view();
  expect(view.operations).toHaveLength(1);
  expect(view.operations[0]).toMatchObject({ state: 'unknown' });
  expect(view.questions).toMatchObject([{ kind: 'recovery', status: 'open' }]);
  expect(view.nodes[0]?.status).toBe('blocked');
});
