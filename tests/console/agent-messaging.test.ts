// The address list for same-graph Agent messaging (R24: failure modes first).
//
// User decision (2026-09-28): add `node_id` so Agents know where the others are, then enhance the
// tools so Agents can talk to each other. No "only while the target is running" restriction.
//
// The addressing unit is therefore (task, node), and the reach rule is: a subagent may address any
// node of its OWN graph, and no other graph. `send_to_peer` does not park a message in an inbox: it
// delivers it to the target node as that node's own input, so the rule is enforced where delivery
// happens (`kernel-node-messages.ts`, covered by `graph-messages.test.ts`). What stays here is the list of
// addresses a node may pick from, which is what this file pins down.
//
// 1. Peer lookup lists every node of the graph with its status, so an Agent can pick a recipient.
// 2. A node of another graph is never in that list - the constraint that replaces the removed
//    chain/ceiling guards.
// 3. The rendered list names the peers, and says so when there are none.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { peerNodes, renderPeers } from '../../src/runtime/agent-messaging.ts';

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
  expect(peers.map(peer => ({ id: peer.id, status: peer.status }))).toEqual([
    { id: 'build', status: 'running' },
    { id: 'check', status: 'pending' },
  ]);
});

test('a node of another graph is not an address this node may pick', async () => {
  const store = await fixture();
  expect(peerNodes(store, 'graphA').map(peer => peer.id)).not.toContain('graphB');
  // The other graph has its own build node, and this graph's node cannot see it.
  expect(peerNodes(store, 'graphB').map(peer => peer.id)).toEqual(['build']);
});

test('the rendered peer list names the others and leaves the node itself out', async () => {
  const store = await fixture();
  const rendered = renderPeers(peerNodes(store, 'graphA'), 'build');
  expect(rendered).toContain('check');
  expect(rendered).not.toContain('build（');
  expect(renderPeers(peerNodes(store, 'graphA'), 'build')).not.toContain('graphB');
});
