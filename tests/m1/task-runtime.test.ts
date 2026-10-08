import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { Proposal, NativeProposal } from '../../src/core/types.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';


const checkDefinition = parseGraphDefinition({ schemaVersion: 2, name: 'Check work', protocols: { data: { type: 'object' } }, nodes: {},
  modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
  edges: {}, acceptance: [{ id: 'works', description: 'Works', kind: 'check', module: 'check' }] });
const checkProposal: NativeProposal = { requirementVersion: 1, summary: 'Check', acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], definition: checkDefinition };

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
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Title search', protocols: { data: { type: 'object' } },
      nodes: { implement: { recipe: 'coder@1', task: 'Implement case-insensitive title search', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { verify: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result' } } },
      edges: { verified: { from: 'implement.result', to: 'verify.job', enabled: true } },
      acceptance: [{ id: 'search', description: 'Matching titles are returned', kind: 'check', module: 'verify' }] }),
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
  const spec = checkProposal;
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
  const valid = checkProposal;
  // Each malformed native definition is submitted unchanged; no converter can
  // repair the missing port, wrong map or dangling acceptance on its way in.
  const base = valid.definition!;
  const invalid = [
    { ...valid, definition: { ...base, nodes: [] } },
    { ...valid, definition: { ...base, edges: { dangling: { from: 'check.nope', to: 'check.job', enabled: true } } } },
    { ...valid, definition: { ...base, inputs: { task: { to: 'check.absent', protocol: 'data' } } } },
    { ...valid, definition: { ...base, modules: { '  ': base.modules.check } } },
    { ...valid, acceptance: [{ id: 'works', description: 'Works', checkNode: 'absent' }] },
  ];
  const expectedCodes = ['invalid_definition', 'invalid_definition', 'invalid_definition', 'invalid_definition', 'invalid_proposal'];
  for (const [index, proposal] of invalid.entries()) {
    await expect(supervisor.propose(proposal as Proposal, `invalid-${index}`)).rejects.toMatchObject({ code: expectedCodes[index] });
  }
  for (const field of ['nodes', 'loops', 'containers']) {
    for (const [index, value] of [[], null, [{ id: 'legacy' }]].entries()) {
      await expect(supervisor.propose({ ...valid, [field]: value }, `mixed-${field}-${index}`))
        .rejects.toMatchObject({ code: 'invalid_proposal', message: expect.stringContaining(field) });
    }
  }
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

test('abandoning a wedged active task hands the slot to the queued task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-abandon-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const spec = { ...checkProposal, definition: parseGraphDefinition({ ...checkDefinition, nodes: {
    waiting: { recipe: 'worker@1', task: 'Wait for an input', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
  } }) };
  // Only a confirmed task takes the single active code slot; a second confirmed
  // task waits in the queue behind it, which is what makes abandoning matter.
  const first = await runtime.user.begin({ projectId: 'project', request: 'First', requestId: 'begin-1' });
  const firstProposal = await runtime.supervisor(first.taskId).propose(spec, 'proposal-1');
  await runtime.user.task(first.taskId).accept({ proposalVersion: firstProposal.proposalVersion, targetBranch: 'main', requestId: 'accept-1' });
  const second = await runtime.user.begin({ projectId: 'project', request: 'Second', requestId: 'begin-2' });
  const secondProposal = await runtime.supervisor(second.taskId).propose(spec, 'proposal-2');
  await runtime.user.task(second.taskId).accept({ proposalVersion: secondProposal.proposalVersion, targetBranch: 'main', requestId: 'accept-2' });
  const queued = await runtime.user.task(second.taskId).view();
  expect(queued.phase).toBe('queued');
  expect(queued.queuedBehind).toMatchObject({ taskId: first.taskId, projectId: 'project', openProblems: 0 });
  await runtime.supervisor(first.taskId).graphSend({ graphId: first.taskId, nodeId: 'waiting', input: 'job', value: { keep: 'cancel this pending work' } });
  const stream = runtime.user.task(first.taskId).watch((await runtime.user.task(first.taskId).view()).cursor);
  const receipt = await runtime.user.task(first.taskId).abandon('abandon-1', 'no path to completion');
  expect(await runtime.user.task(first.taskId).abandon('abandon-1', 'no path to completion')).toEqual(receipt);
  expect((await runtime.user.task(first.taskId).view()).phase).toBe('stopping');
  const queue = await runtime.supervisor(first.taskId).graphInspect({ graphId: first.taskId, query: 'queue' }) as { items: { state: string; reason: string }[] };
  expect(queue.items).toMatchObject([{ state: 'done', reason: 'cancelled by stop' }]);
  expect((await runtime.user.task(second.taskId).view()).phase).toBe('queued');
  await runtime.host.drive();
  expect((await runtime.user.task(first.taskId).view()).phase).toBe('stopped');
  expect(await runtime.user.task(second.taskId).view()).toMatchObject({ phase: 'running', queuedBehind: null });
  expect((await stream.next()).value).toMatchObject({ type: 'graph.stopping' });
  expect((await stream.next()).value).toMatchObject({ type: 'task.stop_requested', cursor: receipt.cursor });
  await stream.return();
  await expect(runtime.user.task(first.taskId).abandon('abandon-2')).rejects.toMatchObject({ code: 'invalid_input' });
});


test('completing a native task releases the confirmed queue without implicitly completing its successor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-task-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const first = await runtime.user.begin({ projectId: 'project', request: 'First', requestId: 'begin-1' });
  await runtime.supervisor(first.taskId).propose(checkProposal, 'draft-1');
  await runtime.user.task(first.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept-1' });
  const second = await runtime.user.begin({ projectId: 'project', request: 'Second', requestId: 'begin-2' });
  await runtime.supervisor(second.taskId).propose(checkProposal, 'draft-2');
  await runtime.user.task(second.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept-2' });
  for (const { taskId } of [first, second]) await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'check', input: 'job', value: {} });
  await runtime.host.drive();
  expect((await runtime.user.task(second.taskId).view()).phase).toBe('queued');
  const secondMain = runtime.supervisor(second.taskId);
  expect(await secondMain.graphInspect({ graphId: second.taskId, query: 'operations' })).toEqual([]);
  const stream = runtime.user.task(second.taskId).watch((await runtime.user.task(second.taskId).view()).cursor);
  await runtime.supervisor(first.taskId).graphControl({ graphId: first.taskId, action: 'complete' });
  await runtime.host.drive();
  expect((await runtime.user.task(first.taskId).view()).phase).toBe('completed');
  expect(await runtime.user.task(second.taskId).view()).toMatchObject({ phase: 'running', queuedBehind: null });
  expect((await stream.next()).value).toMatchObject({ type: 'task.started' }); await stream.return();
  const checks = await secondMain.graphInspect({ graphId: second.taskId, query: 'operations' }) as { state: string }[];
  expect(checks).toMatchObject([{ state: 'settled' }]);
});
