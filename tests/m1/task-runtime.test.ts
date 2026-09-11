import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('a confirmed requirement and its idempotent command receipt survive reopening disk state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }] };
  let runtime = await openTaskRuntime(options);
  cleanup.push(async () => { await runtime.close(); });
  const request = { projectId: 'project', request: 'Add title search', requestId: 'begin-1' };
  const receipt = await runtime.user.begin(request);
  expect(await runtime.user.begin(request)).toEqual(receipt);
  const task = runtime.user.task(receipt.taskId);
  const proposal = await runtime.supervisor(receipt.taskId).propose({
    requirementVersion: 1, summary: 'Search existing items by title',
    acceptance: [{ id: 'search', description: 'Matching titles are returned', checkNode: 'verify' }],
    nodes: [
      { id: 'implement', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'verify', kind: 'program', action: 'verify', dependsOn: ['implement'] },
    ],
  }, 'proposal-1');
  const accepted = await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept-1' });
  const before = await task.view();
  expect(before.proposal).toMatchObject({ summary: 'Search existing items by title', acceptance: [{ id: 'search', checkNode: 'verify' }] });
  await runtime.close();
  runtime = await openTaskRuntime(options);
  expect(await runtime.user.begin(request)).toEqual(receipt);
  expect(await runtime.user.task(receipt.taskId).view()).toMatchObject({
    id: receipt.taskId, phase: 'running', requirementVersion: 1,
    acceptedProposalVersion: proposal.proposalVersion, targetBranch: 'main',
    nodes: before.nodes,
  });
  expect(await runtime.user.task(receipt.taskId).accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept-1' })).toEqual(accepted);
  expect(await runtime.user.list()).toHaveLength(1);
});

test('new requirements invalidate old proposals, additional tasks queue, and event cursors reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-requirements-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const first = await runtime.user.begin({ projectId: 'project', request: 'Title search', requestId: 'begin-1' });
  await expect(runtime.user.begin({ projectId: 'project', request: 'Different content', requestId: 'begin-1' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  const task = runtime.user.task(first.taskId);
  const supervisor = runtime.supervisor(first.taskId);
  const spec = { requirementVersion: 1, summary: 'Title search', acceptance: [{ id: 'works', description: 'Search works', checkNode: 'check' }], nodes: [{ id: 'check', kind: 'program' as const, action: 'check' }] };
  const old = await supervisor.propose(spec, 'proposal-1');
  const before = await task.view();
  const changed = await task.say('Ignore title case', 'say-1');
  expect(await task.say('Ignore title case', 'say-1')).toEqual(changed);
  await expect(task.accept({ proposalVersion: old.proposalVersion, targetBranch: 'main', requestId: 'old-accept' })).rejects.toMatchObject({ code: 'stale_proposal' });
  const stream = task.watch(before.cursor);
  expect((await stream.next()).value).toMatchObject({ cursor: changed.cursor, type: 'requirement.changed' });
  await stream.return();
  const current = await supervisor.propose({ ...spec, requirementVersion: 2 }, 'proposal-2');
  expect((await task.view()).messages).toMatchObject([{ text: 'Title search' }, { text: 'Ignore title case', requirementVersion: 2 }]);
  const accepted = await task.accept({ proposalVersion: current.proposalVersion, targetBranch: 'main', requestId: 'accept-1' });
  const reconnect = task.watch(current.cursor);
  expect((await reconnect.next()).value).toMatchObject({ cursor: accepted.cursor, type: 'task.accepted' });
  await reconnect.return();
  const second = await runtime.user.begin({ projectId: 'project', request: 'Search note bodies too', requestId: 'begin-2' });
  const next = await runtime.supervisor(second.taskId).propose(spec, 'proposal-1');
  await runtime.user.task(second.taskId).accept({ proposalVersion: next.proposalVersion, targetBranch: 'main', requestId: 'accept-2' });
  expect(await task.view()).toMatchObject({ phase: 'running', requirementVersion: 2, request: 'Title search' });
  expect(await runtime.user.task(second.taskId).view()).toMatchObject({ phase: 'queued', request: 'Search note bodies too' });
  expect(supervisor).not.toHaveProperty('accept');
  expect(supervisor).not.toHaveProperty('answer');
});

test('invalid proposals cannot enter confirmed state, and confirmation freezes the task scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-proposal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Check work', requestId: 'begin' });
  const supervisor = runtime.supervisor(taskId);
  const valid = { requirementVersion: 1, summary: 'Check', acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: [{ id: 'check', kind: 'program' as const, action: 'check' }] };
  const invalid = [
    { ...valid, nodes: [] },
    { ...valid, nodes: [valid.nodes[0]!, valid.nodes[0]!] },
    { ...valid, nodes: [{ ...valid.nodes[0]!, dependsOn: ['missing'] }] },
    { ...valid, nodes: [{ ...valid.nodes[0]!, dependsOn: ['check'] }] },
    { ...valid, nodes: [{ ...valid.nodes[0]!, kind: 'agent' as const, model: 'scripted', definitionVersion: 'worker@1' }] },
  ];
  for (const [i, proposal] of invalid.entries()) await expect(supervisor.propose(proposal, `invalid-${i}`)).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect((await runtime.user.task(taskId).view()).proposalVersion).toBe(0);
  const proposed = await supervisor.propose(valid, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await expect(supervisor.propose(valid, 'change-confirmed')).rejects.toMatchObject({ code: 'requirements_locked' });
});

test('failed project configuration leaves no partial registration and releases daemon ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-startup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'original', root }] });
  await runtime.close();
  await expect(openTaskRuntime({ stateDir, projects: [{ id: 'partial', root }, { id: 'original', root: join(root, 'changed') }] })).rejects.toMatchObject({ code: 'project_conflict' });
  const restored = await openTaskRuntime({ stateDir }); cleanup.push(() => restored.close());
  await expect(restored.user.begin({ projectId: 'partial', request: 'Should not exist', requestId: 'invalid' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await restored.user.begin({ projectId: 'original', request: 'Original project', requestId: 'valid' })).toHaveProperty('taskId');
});
