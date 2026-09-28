// Failure modes for same-graph Agent messaging, written before any code (R24).
//
// User decision (2026-09-28): add `node_id` so Agents know where the others are, then enhance the
// tools so Agents can talk to each other. No "only while the target is running" restriction.
//
// The addressing unit therefore becomes (task, node) instead of just conversation, and the reach
// rule is: a subagent may address any node of its OWN graph, and no other graph.
//
// 1. Peer lookup lists every node of the graph with its status, so an Agent can pick a recipient.
// 2. A message is addressed to one node, and the recipient is recorded — not guessed from text.
// 3. A subagent may address a peer in its own graph, running or not.
// 4. A subagent may NOT address a node of another graph — the constraint that replaces the
//    removed chain/ceiling guards.
// 5. A node may not address itself.
// 6. An unknown node id is refused, never silently accepted.
// 7. Inbox reads return only messages addressed to that node (plus broadcasts), never everything.
// 8. Two distinct senders' mail must not collapse: same text from different nodes are two facts.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { peerNodes, sendNodeMessage, nodeInbox, sameGraphReach } from '../../src/runtime/agent-messaging.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-msg-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
    store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
    // The graph under test, and a different graph that must stay out of reach.
    store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('graphA','p','A',1,'running',2,1,'c')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('graphB','p','B',1,'running',3,1,'c')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('graphA','build','{\"role\":\"worker\"}','a1','running')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('graphA','check','{\"role\":\"worker\"}','a2','pending')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('graphB','build','{\"role\":\"worker\"}','b1','running')").run();
  });
  return store;
}

test('an Agent can see where the other Agents of its graph are', async () => {
  const store = await fixture();
  const peers = peerNodes(store, 'graphA');
  expect(peers.map(p => `${p.id}:${p.status}`)).toEqual(['build:running', 'check:pending']);
});

test('a message is addressed to a node, and a pending peer is reachable', async () => {
  const store = await fixture();
  const receipt = sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: '你在等的前提已经满足', requestId: 'm1' });
  expect(receipt).toMatchObject({ to: 'check', from: 'build' });
  // No "only while running" restriction: a pending node can be sent to.
  expect(peersError(() => sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: 'again', requestId: 'm2' }))).toBeNull();
});

function peersError(run: () => unknown) {
  try { run(); return null; } catch (error) { return error as Error; }
}

test('a subagent cannot reach another graph', async () => {
  const store = await fixture();
  const error = peersError(() => sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'graphB:build', text: 'x', requestId: 'm3' }))!;
  expect(String(error.message)).toContain('同一张图');
});

test('a node cannot message itself, and an unknown node is refused', async () => {
  const store = await fixture();
  expect(peersError(() => sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'build', text: 'x', requestId: 'm4' }))!.message).toContain('自己');
  expect(peersError(() => sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'ghost', text: 'x', requestId: 'm5' }))!.message).toContain('ghost');
});

test('the inbox returns what was addressed to that node and nothing else', async () => {
  const store = await fixture();
  sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: 'for check', requestId: 'm6' });
  sendNodeMessage(store, { taskId: 'graphA', from: 'check', to: 'build', text: 'for build', requestId: 'm7' });
  const checkInbox = nodeInbox(store, 'graphA', 'check');
  expect(checkInbox.map(m => m.text)).toEqual(['for check']);
  expect(checkInbox[0]).toMatchObject({ from: 'build', to: 'check' });
});

test('the same text from two different senders stays two facts', async () => {
  const store = await fixture();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('graphA','build2','{\"role\":\"worker\"}','a3','running')").run();
  sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: 'same', requestId: 'm8' });
  sendNodeMessage(store, { taskId: 'graphA', from: 'build2', to: 'check', text: 'same', requestId: 'm9' });
  expect(nodeInbox(store, 'graphA', 'check').length).toBe(2);
});

test('a repeated requestId is idempotent: one message, not two', async () => {
  const store = await fixture();
  sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: 'once', requestId: 'same-req' });
  sendNodeMessage(store, { taskId: 'graphA', from: 'build', to: 'check', text: 'once', requestId: 'same-req' });
  expect(nodeInbox(store, 'graphA', 'check').length).toBe(1);
});

test('reach is decided on the resolved target, so phrasing cannot escape the graph', () => {
  expect(sameGraphReach({ callerTask: 'graphA', callerNode: 'build', targetTask: 'graphA', targetNode: 'check', knownNodes: ['build', 'check'] })).toBeNull();
  expect(sameGraphReach({ callerTask: 'graphA', callerNode: 'build', targetTask: 'graphB', targetNode: 'build', knownNodes: ['build'] })).toContain('同一张图');
});
