import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { NodeSpec , Proposal } from '../../src/core/types.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('the master shares ten global slots, releases its slot while waiting, and reacquires one after a user answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-slots-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const release = deferred();
  const nineWorkers = deferred();
  let active = 0; let peak = 0; let workers = 0; let masterCalls = 0;
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: {
    master: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      masterCalls++; active++; peak = Math.max(peak, active); active--;
      if (masterCalls === 1) return { outcome: 'waiting', output: { plan: 'ready' }, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, question: { prompt: 'Which format?' } };
      expect(operation.context).toMatchObject({ previousOutput: { plan: 'ready' }, answers: [{ value: 'markdown' }] });
      return { outcome: 'completed', output: null, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } },
    worker: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      active++; peak = Math.max(peak, active); workers++; if (workers === 9) nineWorkers.resolve();
      await release.promise; active--;
      return { outcome: 'completed', output: null, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } },
  } });
  cleanup.push(() => runtime.close()); cleanup.push(async () => release.resolve());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Parallel work', requestId: 'begin' });
  const task = runtime.user.task(taskId);
  const agents: NodeSpec[] = [{ id: 'master', kind: 'agent', role: 'master', action: 'master', model: 'scripted', definitionVersion: 'master@1' },
    ...Array.from({ length: 11 }, (_, i): NodeSpec => ({ id: `worker-${i}`, kind: 'agent', action: 'worker', model: 'scripted', definitionVersion: 'worker@1' }))];
  const proposal = await runtime.supervisor(taskId).propose(withLiftedDefinition({ requirementVersion: 1, summary: 'Parallel work', acceptance: [{ id: 'works', description: 'All work checked', checkNode: 'check' }],
    nodes: [...agents, { id: 'check', kind: 'program', action: 'check', dependsOn: agents.map(node => node.id) }],
  } as Proposal), 'proposal');
  await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  const first = runtime.host.runReady();
  await nineWorkers.promise;
  const waiting = await task.view();
  expect(waiting.nodes[0]).toMatchObject({ status: 'waiting', used: 20, reserved: 0 });
  expect(waiting.operations.filter(operation => operation.workerActive)).toHaveLength(9);
  const second = runtime.host.runReady();
  const answer = { type: 'respond' as const, value: 'markdown' };
  await task.answer(waiting.questions[0]!.id, answer, 'answer');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(masterCalls).toBe(1);
  release.resolve();
  expect(await first).toEqual({ dispatched: 10 });
  expect(await second).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 2 });
  expect(masterCalls).toBe(2); expect(workers).toBe(11); expect(peak).toBeLessThanOrEqual(10);
  expect((await task.view()).nodes[0]).toMatchObject({ instanceId: waiting.nodes[0]!.instanceId, used: 40 });
});

test('resolving the final blocker completes the task and durably advances the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: {
    work: { kind: 'agent', reserveTokens: 1, prepare: async () => async () => ({ outcome: 'completed', output: null, usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } }) },
    check: { kind: 'program', prepare: async () => async () => {
      const artifact = join(root, 'report.txt'); await writeFile(artifact, 'Check completed');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'Program check completed', artifact: { path: artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex') } }] };
    } },
  } });
  cleanup.push(() => runtime.close());
  const create = async (requestId: string, nodes: NodeSpec[]) => {
    const { taskId } = await runtime.user.begin({ projectId: 'project', request: requestId, requestId });
    const proposed = await runtime.supervisor(taskId).propose(withLiftedDefinition({ requirementVersion: 1, summary: requestId, acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes } as Proposal), 'proposal');
    const task = runtime.user.task(taskId);
    await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: `accept-${requestId}` });
    return task;
  };
  const first = await create('first', [{ id: 'work', kind: 'agent', action: 'work', model: 'scripted', definitionVersion: 'worker@1' }, { id: 'check', kind: 'program', action: 'check' }]);
  const second = await create('second', [{ id: 'check', kind: 'program', action: 'check' }]);
  expect((await second.view()).phase).toBe('queued');
  await runtime.host.runReady();
  const blocked = await first.view();
  await first.answer(blocked.questions[0]!.id, { type: 'acknowledge' }, 'acknowledge');
  expect((await first.view()).phase).toBe('completed');
  expect((await second.view()).phase).toBe('running');
  const updates = second.watch(blocked.cursor);
  expect((await updates.next()).value).toMatchObject({ type: 'task.started' }); await updates.return();
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect((await second.view()).phase).toBe('completed');
});
