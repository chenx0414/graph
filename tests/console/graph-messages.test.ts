// The graph picture draws one arc per peer message that really happened.
//
// `graphMessages` is the only source of the canvas's message edges. It used to read
// `messages.kind='agent_message'`, and when peer delivery was changed to hand the words straight to
// the target node (steering its turn, or reactivating it), that row stopped being written - nothing
// in the repository writes it any more. The picture then kept its shape while quietly dropping
// facts: a real run had three peer messages between its nodes and the graph drew none of them.
//
// These assertions are about the same thing the canvas asks for, and the fixture is built by
// sending a peer message through the product's own path rather than by inserting a row.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { scriptedLane } from '../fixtures/lane.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'graph-messages-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const lane = scriptedLane();
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], actions: {
    work: lane.action,
    check: { kind: 'program', prepare: async operation => async () => {
      const path = join(root, `ok-${operation.id}.txt`); await writeFile(path, 'ok');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path, digest: createHash('sha256').update('ok').digest('hex') } }] };
    } },
  } });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'peer messages', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'peer messages', acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }], nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'sibling', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'sibling'] },
  ] }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const store = new TaskStore(join(root, 'state/tasks.sqlite')); cleanup.push(() => store.close());
  return { runtime, taskId, store };
}

test('a peer message that happened is what the graph draws, and deleting its record empties the picture', async () => {
  const { runtime, taskId, store } = await setup();
  await runtime.host.drive();
  expect(runtime.graphMessages(taskId)).toHaveLength(0);

  const delivered = await runtime.sendPeerMessage(taskId, 'work', { to: 'sibling', text: '你的诊断脚本里那段路径要 realpath 后再比', requestId: 'peer-1' });
  expect(delivered).toMatchObject({ taskId, nodeId: 'sibling' });

  // What the canvas asks for: one message, from the sender to the receiver, with the words.
  const messages = runtime.graphMessages(taskId);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ source: 'work', target: 'sibling', text: '你的诊断脚本里那段路径要 realpath 后再比' });
  expect(messages[0]!.id).toBeTruthy();
  expect(messages[0]!.createdAt).toBeGreaterThan(0);

  // A user message to a node is not a peer message and must not be drawn as one.
  await runtime.sendNodeMessage(taskId, 'work', { text: '用户的话', requestId: 'user-1' });
  expect(runtime.graphMessages(taskId)).toHaveLength(1);

  // The picture is bound to the record, not to a cached copy: no record, no arc.
  store.db.prepare('DELETE FROM node_entries WHERE task_id=? AND json_extract(data,\'$.peer\')=1').run(taskId);
  expect(runtime.graphMessages(taskId)).toHaveLength(0);
});
