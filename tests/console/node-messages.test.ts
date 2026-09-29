import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { scriptedLane, laneUsage, laneResult, settle } from '../fixtures/lane.ts';
import type { ActionAdapter } from '../../src/core/types.ts';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
async function setup(worker?: ActionAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-message-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const lane = scriptedLane();
  const checks: string[] = [];
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], actions: {
    work: worker ?? lane.action, sibling: scriptedLane().action,
    check: { kind: 'program', prepare: async operation => async () => {
      checks.push(operation.id);
      const path = join(root, 'ok.txt'); await writeFile(path, 'ok');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path, digest: createHash('sha256').update('ok').digest('hex') } }] };
    } },
  } });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'message node', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'message node', acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }], nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'sibling', kind: 'agent', action: 'sibling', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'sibling'] },
  ] }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const store = new TaskStore(join(root, 'state/tasks.sqlite')); cleanup.push(() => store.close());
  return { runtime, taskId, store, lane, checks };
}
test('completed-node messages invalidate only descendants, preserve instance and budget, and reach the next briefing once', async () => {
  const { runtime, taskId, store, lane, checks } = await setup();
  await runtime.host.drive();
  expect(store.task(taskId).phase).toBe('completed');
  const before = runtime.nodeRun(taskId, 'work');
  const sibling = runtime.nodeRun(taskId, 'sibling');
  const input = { text: '请补充边界情况', requestId: 'followup' };
  expect(await runtime.sendNodeMessage(taskId, 'work', input)).toMatchObject({ state: 'rework', affected: ['work', 'check'] });
  expect(await runtime.sendNodeMessage(taskId, 'work', input)).toMatchObject({ state: 'rework' });
  await runtime.sendNodeMessage(taskId, 'work', { text: '也保留原有行为', requestId: 'followup-extra' });
  expect(runtime.nodeRun(taskId, 'sibling').node.status).toBe('succeeded');
  await runtime.host.drive();
  const after = runtime.nodeRun(taskId, 'work');
  expect(after.instance?.id).toBe(before.instance?.id);
  expect(after.instance!.used).toBeGreaterThan(before.instance!.used);
  expect(runtime.nodeRun(taskId, 'sibling').operations.length).toBe(sibling.operations.length);
  expect(checks).toHaveLength(2);
  expect(lane.briefings).toHaveLength(2);
  expect(lane.briefings[1]).toContain('请补充边界情况');
  expect(lane.briefings[1]).toContain('也保留原有行为');
  expect(after.entries.filter(entry => entry.kind === 'chat')).toHaveLength(2);
  await expect(runtime.sendNodeMessage(taskId, 'check', { text: 'wrong', requestId: 'program' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(runtime.sendNodeMessage(taskId, 'work', { text: 'different', requestId: 'followup' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
test('live messages steer only their operation and retries do not deliver twice', async () => {
  const delivered: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const { runtime, taskId } = await setup({ kind: 'agent', reserveTokens: 100,
    steer: async (operation, text) => { delivered.push(`${operation.nodeId}:${text}`); return { ordinal: 1 }; },
    prepare: async () => async () => { await waiting; return { outcome: 'completed', output: laneResult(), usage: laneUsage }; },
  });
  try {
    const dispatched = runtime.host.runReady();
    await settle(() => runtime.nodeRun(taskId, 'work').node.status === 'running', async () => {});
    const input = { text: '处理空值', requestId: 'steer' };
    expect(await runtime.sendNodeMessage(taskId, 'work', input)).toMatchObject({ state: 'steered' });
    await runtime.sendNodeMessage(taskId, 'work', input);
    finish();
    await dispatched;
    expect(delivered).toEqual(['work:处理空值']);
    expect(runtime.nodeRun(taskId, 'work').entries.filter(entry => entry.role === 'user')).toHaveLength(1);
  } finally { finish(); }
});

test('a peer message to a finished node reactivates it and reaches the next briefing like a user prompt', async () => {
  const { runtime, taskId, store, lane, checks } = await setup();
  await runtime.host.drive();
  expect(store.task(taskId).phase).toBe('completed');
  const before = runtime.nodeRun(taskId, 'work');
  expect(before.node.status).toBe('succeeded');

  const receipt = await runtime.sendPeerMessage(taskId, 'sibling', { to: 'work', text: '请补充边界情况', requestId: 'peer-1' });
  expect(receipt).toMatchObject({ state: 'rework' });
  // The delivery is a real node entry the node chat window reads, marked as coming from a peer.
  const entry = runtime.nodeRun(taskId, 'work').entries.find(item => item.kind === 'chat');
  expect(entry?.text).toBe('请补充边界情况');
  expect(entry?.data).toMatchObject({ from: 'sibling' });

  await runtime.host.drive();
  expect(runtime.nodeRun(taskId, 'work').instance?.id).toBe(before.instance?.id);
  expect(lane.briefings.at(-1)).toContain('请补充边界情况');
  // The sibling is untouched: only the addressed node and its descendants rerun.
  expect(runtime.nodeRun(taskId, 'sibling').operations.length).toBe(1);
  expect(checks).toHaveLength(2);
});

test('a peer message to a running node steers that operation instead of restarting it', async () => {
  const delivered: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const { runtime, taskId } = await setup({ kind: 'agent', reserveTokens: 100,
    steer: async (operation, text) => { delivered.push(`${operation.nodeId}:${text}`); return { ordinal: 1 }; },
    prepare: async () => async () => { await waiting; return { outcome: 'completed', output: laneResult(), usage: laneUsage }; },
  });
  try {
    const dispatched = runtime.host.runReady();
    await settle(() => runtime.nodeRun(taskId, 'work').node.status === 'running', async () => {});
    const receipt = await runtime.sendPeerMessage(taskId, 'sibling', { to: 'work', text: '先处理空值', requestId: 'peer-live' });
    expect(receipt).toMatchObject({ state: 'steered' });
    finish();
    await dispatched;
    expect(delivered).toEqual(['work:先处理空值']);
    expect(runtime.nodeRun(taskId, 'work').entries.filter(entry => entry.kind === 'chat')).toHaveLength(1);
  } finally { finish(); }
});
