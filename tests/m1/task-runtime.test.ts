import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { Proposal } from '../../src/core/types.ts';
import { liftDefinition as definitionFor } from '../fixtures/v2-lift.ts';

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
  // Each case states its own definition. An earlier version rebuilt the definition from
  // `nodes` at propose time, which silently repaired three of these - a duplicate id, a
  // dangling port and a self-edge all became legal - so the suite went green while the
  // cases it named were no longer being exercised at all.
  // Each case states its own definition, and each one is a rule the v2 interface really
  // enforces. An earlier version rebuilt the definition from `nodes` at propose time,
  // which silently repaired three of these, so the suite went green while the cases it
  // named were no longer being exercised. Two cases were dropped rather than faked: a
  // duplicate node id cannot exist in a JS object literal, and a self-edge is a legal
  // (if useless) edge - neither is an error the interface claims to catch.
  const base = definitionFor(valid.nodes) as unknown as { nodes: Record<string, unknown> } & Record<string, unknown>;
  const invalid = [
    // a definition whose maps are not maps
    { ...valid, definition: { ...base, nodes: [] } as never },
    // an edge whose endpoint port does not exist
    { ...valid, definition: { ...base, edges: { dangling: { from: 'check.nope', to: 'check.in', enabled: true } } } as never },
    // a graph input naming a port no node declares
    { ...valid, definition: { ...base, inputs: { task: { to: 'check.absent', protocol: 'lifted-payload' } } } as never },
    // a blank node id
    { ...valid, definition: { ...base, nodes: { '  ': base.nodes!['check'] } } as never },
    // an acceptance check naming a node that is not in the graph
    { ...valid, acceptance: [{ id: 'works', description: 'Works', checkNode: 'absent' }], definition: base as never },
  ];
  // Deliberately NOT lifted: these cases assert that a malformed graph definition is
  // refused (duplicate node ids, a dangling dependsOn, a self-cycle). Lifting them would
  // make each case fail for the new "no definition" reason instead of the reason it names,
  // so the suite would stay green while testing nothing it claims to test.
  // The code differs by where the rule lives: a broken definition is caught by the
  // interface parser, a broken acceptance list by the proposal validator. Under the old
  // shape every one of these was `invalid_proposal`, because the nodes array was itself
  // the draft. The refusal is the point of each case; the code it carries is the new one.
  const expectedCodes = ['invalid_definition', 'invalid_definition', 'invalid_definition', 'invalid_definition', 'invalid_proposal'];
  for (const [i, proposal] of invalid.entries()) {
    // A malformed graph definition is refused as `invalid_definition` - the interface
    // parses the definition before the draft is read as a proposal. Under the old shape
    // these same five mistakes surfaced as `invalid_proposal`, because the nodes array was
    // the draft. The refusal is the point of the case; the code it carries is the new one.
    await expect(supervisor.propose(proposal as never, `invalid-${i}`)).rejects.toMatchObject({ code: expectedCodes[i] });
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
  const spec = { requirementVersion: 1, summary: 'Check', acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: [{ id: 'check', kind: 'program' as const, action: 'check' }] };
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
  const stream = runtime.user.task(first.taskId).watch((await runtime.user.task(first.taskId).view()).cursor);
  const receipt = await runtime.user.task(first.taskId).abandon('abandon-1', 'no path to completion');
  expect(await runtime.user.task(first.taskId).abandon('abandon-1', 'no path to completion')).toEqual(receipt);
  expect((await runtime.user.task(first.taskId).view()).phase).toBe('abandoned');
  expect(await runtime.user.task(second.taskId).view()).toMatchObject({ phase: 'running', queuedBehind: null });
  expect((await stream.next()).value).toMatchObject({ type: 'task.abandoned', cursor: receipt.cursor });
  await stream.return();
  await expect(runtime.user.task(first.taskId).abandon('abandon-2')).rejects.toMatchObject({ code: 'invalid_input' });
});
