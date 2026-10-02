import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter , Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

test('the master discusses, proposes a validated graph, and workers receive a briefing without copied user context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-plan-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>>;
  const actions: Record<string, ActionAdapter> = {
    master: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      expect(operation.context.messages?.some(message => message.text.includes('Ship title search'))).toBe(true);
      await runtime.supervisor(operation.taskId).propose({
        requirementVersion: operation.requirementVersion, summary: 'Title search',
        acceptance: [{ id: 'works', description: 'Search ignores case', checkNode: 'check' }],
        nodes: [
          { id: 'master', kind: 'agent', action: 'master', role: 'master', definitionVersion: 'master@1', model: 'scripted' },
          { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted', dependsOn: ['master'] },
          { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
        ],
      }, 'plan');
      return { outcome: 'completed', output: { planned: true }, usage };
    } },
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      expect(operation.context.briefing).toContain('Search ignores case');
      expect(operation.context.briefing).toContain('Ship title search');
      return { outcome: 'completed', output: { done: true }, usage };
    } },
    check: { kind: 'program', prepare: async () => async () => {
      const path = join(root, 'ok.txt'); await writeFile(path, 'ok');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'Checked', artifact: { path, digest: createHash('sha256').update('ok').digest('hex') } }] };
    } },
  };
  runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' }, actions,
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Ship title search', requestId: 'begin' });
  const task = runtime.user.task(taskId);
  expect((await task.view()).phase).toBe('discussing');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const planned = await task.view();
  expect(planned.proposalVersion).toBe(1);
  await expect(runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Bad', acceptance: [{ id: 'works', description: 'x', checkNode: 'missing' }],
    nodes: [{ id: 'check', kind: 'program', action: 'check' }],
  }, 'bad')).rejects.toMatchObject({ code: 'invalid_proposal' });
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect((await task.view()).nodes.find(node => node.id === 'master')?.instanceId).toBe(planned.nodes.find(node => node.id === 'master')?.instanceId);
});

test('a new feature starts a queued task while the original confirmed scope continues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
      check: { kind: 'program', prepare: async () => async () => {
        const path = join(root, 'ok.txt'); await writeFile(path, 'ok');
        return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: createHash('sha256').update('ok').digest('hex') } }] };
      } },
    },
  });
  cleanup.push(() => runtime.close());
  const first = await runtime.user.begin({ projectId: 'project', request: 'Original', requestId: 'begin-1' });
  const proposed = await runtime.supervisor(first.taskId).propose({
    requirementVersion: 1, summary: 'Original',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] }],
  }, 'proposal');
  await runtime.user.task(first.taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  const second = await runtime.user.begin({ projectId: 'project', request: 'New feature', requestId: 'begin-2' });
  const next = await runtime.supervisor(second.taskId).propose({
    requirementVersion: 1, summary: 'New feature',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'check', kind: 'program', action: 'check' }],
  }, 'proposal-2');
  await runtime.user.task(second.taskId).accept({ proposalVersion: next.proposalVersion, targetBranch: 'main', requestId: 'accept-2' });
  expect((await runtime.user.task(second.taskId).view()).phase).toBe('queued');
  await runtime.host.drive();
  expect((await runtime.user.task(first.taskId).view()).phase).toBe('completed');
  expect((await runtime.user.task(first.taskId).view()).request).toBe('Original');
  expect((await runtime.user.task(second.taskId).view()).phase).toBe('completed');
});
