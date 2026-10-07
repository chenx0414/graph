// End-to-end proof of the tool surface a real worker turn receives (R23).
//
// This drives the real tool factory with a real store and real graph rows - the same code path a
// worker's turn takes - and reads the effect back out, not out of a mock. The delivery itself is
// proven where it happens: `graph-messages.test.ts` drives resident Pi and the real runtime and reads the effect out
// of the database, including the cross-graph refusal this file's reach assertion used to make.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { agentTools } from '../../src/runtime/agent-tools.ts';
import { peerNodes } from '../../src/runtime/agent-messaging.ts';

test('a worker is offered list_peers and send_to_peer, and no inbox: a peer message arrives as a prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-agents-e2e-'));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  try {
    store.transaction(() => {
      store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
      store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
      store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('gA','p','graph A',1,'running',2,1,'c')").run();
      store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('gB','p','graph B',1,'running',3,1,'c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('gA','build','{\"role\":\"worker\"}','a1','running')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('gA','check','{\"role\":\"worker\"}','a2','pending')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('gB','build','{\"role\":\"worker\"}','b1','running')").run();
    });

    // Exactly the channel a worker turn is given: delivery to a peer node, nothing else.
    const delivered: { to: string; text: string; requestId: string }[] = [];
    const declarations = agentTools({
      workspace: root, role: 'worker', readOnly: false,
      peers: {
        list: async () => peerNodes(store, 'gA').map(node => ({ id: node.id, role: node.role, status: node.status })),
        send: async request => {
          delivered.push({ to: request.to, text: request.text, requestId: request.requestId });
          return { taskId: 'gA', nodeId: request.to, state: 'rework' };
        },
      },
    });
    // The tool surface a worker really receives, keyed by name.
    const tools = Object.fromEntries(declarations.map(declaration => [declaration.name, declaration.execute])) as Record<string, (id: string, params: unknown) => Promise<unknown>>;
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['list_peers', 'send_to_peer']));
    // There is no inbox to poll: the peer's words are delivered as the peer's own input, so a second
    // reading surface over the same fact is a way to spend a turn on nothing (measured: 4 of 7 nodes
    // in task 68543fed called it and got an empty result).
    expect(Object.keys(tools)).not.toContain('read_peer_messages');

    // 1. The worker can see where its peers are: this is what "node_id so agents know where the
    //    others are" buys. The other graph's node must not appear.
    const listed = JSON.parse(await body(tools.list_peers!('', {})));
    expect(listed.peers.map((p: { id: string }) => p.id).sort()).toEqual(['build', 'check']);

    // 2. It can address a peer that is not running yet - no "only while running" restriction.
    const sent = JSON.parse(await body(tools.send_to_peer!('', { to: 'check', text: '前提已满足，可以开工', requestId: 'e2e-1' })));
    expect(sent).toMatchObject({ nodeId: 'check', state: 'rework' });
    // The tool hands the words to the delivery channel rather than storing them somewhere to be read.
    expect(delivered).toEqual([{ to: 'check', text: '前提已满足，可以开工', requestId: 'e2e-1' }]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE request_id='e2e-1'").get()).toMatchObject({ n: 0 });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The tool handlers are async; awaiting here keeps every call site honest - passing the promise
// unawaited is exactly how this helper first failed.
async function body(value: unknown): Promise<string> {
  const result = await value as { content?: { text?: string }[] };
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`tool returned no text: ${JSON.stringify(result)?.slice(0, 200)}`);
  return text;
}
