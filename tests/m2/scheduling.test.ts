import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, NodeSpec, Proposal } from '../../src/core/types.ts';
import type { ReviewReport, VerifierConfig } from '../../src/core/verification.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const json = (value: unknown): Json => value as Json;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const coder = { definitionVersion: 'coder@1', model: 'scripted' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function setup(actions: Record<string, ActionAdapter>, proposal: Proposal) {
  const root = await mkdtemp(join(tmpdir(), 'graph-sched-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: proposal.summary, requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose(proposal, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task, taskId, options };
}

test('drive starts an independent successor before a slow sibling finishes', async () => {
  const release = deferred();
  let checkStarted = false;
  const { runtime, task, root } = await setup({
    slow: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { await release.promise; return { outcome: 'completed', output: { slow: true }, usage }; } },
    fast: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { fast: true }, usage }) },
    afterFast: { kind: 'program', prepare: async () => async () => { checkStarted = true; return { outcome: 'completed', output: { ready: true } }; } },
    check: { kind: 'program', prepare: async () => async () => {
      const path = join(root, 'ok.txt'); await writeFile(path, 'ok');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'Joined', artifact: { path, digest: digest('ok') } }] };
    } },
  }, {
    requirementVersion: 1, summary: 'Independent successor',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'slow', kind: 'agent', action: 'slow', ...coder },
      { id: 'fast', kind: 'agent', action: 'fast', ...coder },
      { id: 'afterFast', kind: 'program', action: 'afterFast', dependsOn: ['fast'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['slow', 'afterFast'] },
    ],
  });
  const driven = runtime.host.drive();
  await waitUntil(() => checkStarted);
  expect((await task.view()).operations.some(operation => operation.nodeId === 'slow' && operation.workerActive)).toBe(true);
  expect((await task.view()).nodes.find(node => node.id === 'afterFast')?.status).toBe('succeeded');
  release.resolve();
  await driven;
  expect((await task.view()).phase).toBe('completed');
});

test('pump dispatches a new conversation even while an earlier master worker hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pump-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let releaseHang!: () => void;
  const hang = new Promise<void>(resolve => { releaseHang = resolve; });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      calls += 1;
      if (calls === 1) { await hang; return { outcome: 'completed' as const, output: { text: 'first eventually' }, usage }; }
      return { outcome: 'completed' as const, output: { text: 'second reply' }, usage };
    } } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  cleanup.push(async () => releaseHang());
  await runtime.conversations.create({ text: 'first', requestId: 'first' });
  expect(await runtime.host.pump()).toEqual({ dispatched: 1 });
  const second = await runtime.conversations.create({ text: 'second', requestId: 'second' });
  // A hung worker on the first master must not starve the second conversation.
  expect(await runtime.host.pump()).toEqual({ dispatched: 1 });
  await waitUntil(async () => (await runtime.conversations.view(second.conversationId)).messages.some(message => message.role === 'assistant'));
  const view = await runtime.conversations.view(second.conversationId);
  expect(view.messages.find(message => message.role === 'assistant')?.text).toBe('second reply');
});

test('nested workers share the ten-agent pool and the master never becomes an eleventh', async () => {
  const release = deferred();
  let peak = 0; let active = 0;
  const workers: NodeSpec[] = Array.from({ length: 11 }, (_, i) => ({ id: `worker-${i}`, kind: 'agent', action: 'worker', ...coder, container: 'inner' }));
  const { runtime } = await setup({
    master: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      active++; peak = Math.max(peak, active); active--;
      return { outcome: 'completed', output: { plan: true }, usage };
    } },
    worker: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      active++; peak = Math.max(peak, active); await release.promise; active--;
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async () => async () => {
      const path = '/tmp/unused';
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('x') } }] };
    } },
  }, {
    requirementVersion: 1, summary: 'Nested slots',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    containers: [{ id: 'inner', outputs: workers.map(node => node.id) }],
    nodes: [
      { id: 'master', kind: 'agent', role: 'master', action: 'master', ...coder },
      ...workers.map(node => ({ ...node, dependsOn: ['master'] })),
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['master', 'inner'] },
    ],
  });
  cleanup.push(async () => release.resolve());
  const driven = runtime.host.drive();
  await waitUntil(() => peak >= 10);
  expect(peak).toBeLessThanOrEqual(10);
  release.resolve();
  await driven;
  expect(peak).toBeLessThanOrEqual(10);
});

test('three no-progress rounds become a local stall while an independent branch continues', async () => {
  const releaseIndependent = deferred();
  let lateRan = false;
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'work', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const { runtime, task, taskId, options, root } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      const path = join(root, 'work.txt'); await writeFile(path, 'same');
      return { outcome: 'completed', output: { text: 'same' }, usage, artifacts: [{ id: 'work', path, digest: digest('same') }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const artifact = operation.dependencySources.work![0]!.artifacts[0]!;
      const report: ReviewReport = { schemaVersion: 1, subject: artifact,
        body: { kind: 'multiview', dimensions: { correctness: { verdict: 'fail', reason: 'Still missing the required result', evidence: [artifact] } } } };
      return { outcome: 'completed', output: json(report), usage };
    } },
    independent: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { await releaseIndependent.promise; return { outcome: 'completed', output: { ok: true }, usage }; } },
    late: { kind: 'program', prepare: async () => async () => { lateRan = true; return { outcome: 'completed', output: { late: true } }; } },
  }, {
    requirementVersion: 1, summary: 'Stall locally',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'gate' }],
    loops: [{ from: 'gate', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', ...coder },
      { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['work'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier: config },
      { id: 'independent', kind: 'agent', action: 'independent', ...coder },
      { id: 'late', kind: 'program', action: 'late', dependsOn: ['independent'] },
    ],
  });
  const driven = runtime.host.drive();
  await waitUntil(async () => (await task.view()).questions.some(question => question.kind === 'stalled'));
  const stalled = await task.view();
  expect(stalled.nodes.find(node => node.id === 'work')?.stallCount).toBe(3);
  expect(stalled.questions).toMatchObject([{ kind: 'stalled', nodeId: 'gate', data: { resume: ['work'] } }]);
  expect((stalled.questions[0]!.data as { attempts: unknown[] }).attempts.length).toBeGreaterThan(0);
  expect(stalled.nodes.find(node => node.id === 'independent')?.status).toBe('running');
  releaseIndependent.resolve();
  await driven;
  expect(lateRan).toBe(true);
  expect((await task.view()).phase).toBe('running');
  await runtime.close();
  const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.user.task(taskId);
  await recovered.resume('resume');
  expect(await restored.host.runReady()).toEqual({ dispatched: 0 });
  const open = (await recovered.view()).questions.find(question => question.kind === 'stalled')!;
  await recovered.answer(open.id, { type: 'retry' }, 'retry-stall');
  expect((await recovered.view()).nodes.find(node => node.id === 'work')?.stallCount).toBe(0);
  expect((await recovered.view()).nodes.find(node => node.id === 'work')?.status).toBe('pending');
  expect((await recovered.view()).questions.filter(question => question.status === 'open')).toEqual([]);
});

test('passing a previously failed dimension resets the consecutive stall count', async () => {
  let round = 0;
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'work', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }, { id: 'security', required: true, reportNode: 'review' }] };
  const { runtime, task, root } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      round++;
      const path = join(root, 'work.txt'); await writeFile(path, `r${round}`);
      return { outcome: 'completed', output: { round }, usage, artifacts: [{ id: 'work', path, digest: digest(`r${round}`) }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const artifact = operation.dependencySources.work![0]!.artifacts[0]!;
      const version = (operation.dependencies.work as { round: number }).round;
      const report: ReviewReport = { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: {
        correctness: { verdict: version === 1 ? 'fail' : 'pass', reason: 'Correctness', evidence: [artifact] },
        security: { verdict: version < 3 ? 'fail' : 'pass', reason: 'Security', evidence: [artifact] },
      } } };
      return { outcome: 'completed', output: json(report), usage };
    } },
  }, {
    requirementVersion: 1, summary: 'Progress resets stalls',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'gate' }],
    loops: [{ from: 'gate', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', ...coder },
      { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['work'] },
      { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['work', 'review'], verifier: config },
    ],
  });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.nodes.find(node => node.id === 'work')?.stallCount).toBe(0);
  expect(round).toBe(3);
});

async function waitUntil(predicate: () => unknown, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
