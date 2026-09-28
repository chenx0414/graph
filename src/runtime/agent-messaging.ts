import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { sameGraphReach } from './conversation-scope.ts';
export { sameGraphReach } from './conversation-scope.ts';

/**
 * Agents of one graph talking to each other.
 *
 * A conversation message carries no recipient, which is why "worker A asks worker B" had no
 * carrier at all: the row said who wrote it and nothing about who it was for. This module adds
 * that address — `node_id` is the sender, `to_node_id` the recipient — and the reach rule from
 * `conversation-scope.ts` keeps every message inside one graph, so a subagent cannot command
 * another graph by naming it.
 *
 * There is deliberately no "only while the target is running" restriction: a message is durable,
 * and a node that has not started yet will still find it in its inbox.
 */

export interface PeerNode {
  id: string;
  status: string;
  role: string | null;
}

export interface NodeMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  createdAt: number;
}

/** Where the other Agents of this graph are, so one can be addressed by name. */
export function peerNodes(store: TaskStore, taskId: string): PeerNode[] {
  store.task(taskId);
  const rows = store.db.prepare('SELECT id,status,json_extract(spec,\'$.role\') AS role FROM nodes WHERE task_id=? ORDER BY rowid')
    .all(taskId) as { id: string; status: string; role: string | null }[];
  return rows.map(row => ({ id: row.id, status: row.status, role: row.role }));
}

/** The conversation this graph's messages live on. */
function conversationOf(store: TaskStore, taskId: string): string {
  const row = store.db.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(taskId) as { conversation_id: string | null } | undefined;
  if (!row?.conversation_id) throw new Error(`任务 ${taskId} 没有会话，不能投递节点消息。`);
  return row.conversation_id;
}

export interface SendNodeMessageInput {
  taskId: string;
  /** The sending node, as the runtime knows it. */
  from: string;
  /** The receiving node id; may be `task:node` to name another graph, which is then refused. */
  to: string;
  text: string;
  requestId: string;
}

/**
 * Send one message to a peer node. The address is resolved before anything is written, so a
 * refusal never leaves a half-recorded message behind.
 */
export function sendNodeMessage(store: TaskStore, input: SendNodeMessageInput): NodeMessage {
  const [targetTask, targetNode] = input.to.includes(':') ? input.to.split(':', 2) as [string, string] : [input.taskId, input.to];
  const nodes = peerNodes(store, input.taskId).map(node => node.id);
  const refusal = sameGraphReach({
    callerTask: input.taskId, callerNode: input.from, targetTask, targetNode,
    ...(targetTask === input.taskId ? { knownNodes: nodes } : { knownTasks: taskIds(store) }),
  });
  if (refusal) throw new Error(refusal);
  const conversationId = conversationOf(store, input.taskId);
  // Idempotent by requestId: a retried send is the same fact, not a second message.
  const existing = store.db.prepare('SELECT id,node_id,to_node_id,text,created_at FROM messages WHERE conversation_id=? AND request_id=?')
    .get(conversationId, input.requestId) as { id: string; node_id: string | null; to_node_id: string | null; text: string; created_at: number } | undefined;
  if (existing) {
    return { id: existing.id, from: existing.node_id ?? input.from, to: existing.to_node_id ?? targetNode, text: existing.text, createdAt: existing.created_at };
  }
  const id = randomUUID();
  const now = Date.now();
  store.db.prepare("INSERT INTO messages(conversation_id,id,role,kind,text,data,state,node_id,to_node_id,request_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(conversationId, id, 'assistant', 'agent_message', input.text,
      canonicalJson({ kind: 'agent_message', from: input.from, to: targetNode, taskId: input.taskId }),
      'done', input.from, targetNode, input.requestId, 0, now, now);
  store.event(input.taskId, 'node.message_sent', { from: input.from, to: targetNode, messageId: id });
  return { id, from: input.from, to: targetNode, text: input.text, createdAt: now };
}

/** Messages addressed to this node, oldest first. A node's own sends are not in its inbox. */
export function nodeInbox(store: TaskStore, taskId: string, nodeId: string): NodeMessage[] {
  const conversationId = conversationOf(store, taskId);
  const rows = store.db.prepare("SELECT id,node_id,to_node_id,text,created_at FROM messages WHERE conversation_id=? AND to_node_id=? ORDER BY seq")
    .all(conversationId, nodeId) as { id: string; node_id: string | null; to_node_id: string; text: string; created_at: number }[];
  return rows.map(row => ({ id: row.id, from: row.node_id ?? 'unknown', to: row.to_node_id, text: row.text, createdAt: row.created_at }));
}

function taskIds(store: TaskStore): string[] {
  return (store.db.prepare('SELECT id FROM tasks').all() as { id: string }[]).map(row => row.id);
}

/** How to describe a peer to the model, so it knows what it may address. */
export function renderPeers(peers: PeerNode[], self: string): string {
  const others = peers.filter(peer => peer.id !== self);
  if (others.length === 0) return '这张图里目前只有你自己。';
  return others.map(peer => `${peer.id}（${peer.role ?? 'agent'}，${peer.status}）`).join('、');
}
