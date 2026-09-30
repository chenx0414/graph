import { type TaskStore } from '../core/store.ts';

/**
 * Agents of one graph talking to each other.
 *
 * A conversation message carries no recipient, which is why "worker A asks worker B" had no carrier
 * at all: the row said who wrote it and nothing about who it was for. A peer message is addressed
 * instead, and it is delivered rather than parked. `send_to_peer` reaches the target node as its own
 * input — steering a running turn, or reactivating a finished node so the message becomes the input
 * of its next turn (see `node-messages.ts`). That is why there is deliberately no inbox to poll: the
 * target already received the words as a prompt, in its own chat window, and re-reading them from
 * somewhere else would be a second, weaker copy of a fact it already has.
 *
 * The reach rule is the graph itself. A subagent talks to the nodes of its own graph and to nobody
 * else, because another graph's nodes are not in this list and `node-messages.ts` refuses a target it
 * cannot find; the master's deliberate reach into other conversations lives in `conversation-tools.ts`.
 *
 * What stays here is the address list: which Agents of this graph exist, so one can be addressed by
 * name and the briefing can say who else is in the room.
 */

export interface PeerNode {
  id: string;
  status: string;
  role: string | null;
}

/** Where the other Agents of this graph are, so one can be addressed by name. */
export function peerNodes(store: TaskStore, taskId: string): PeerNode[] {
  store.task(taskId);
  const rows = store.db.prepare('SELECT id,status,json_extract(spec,\'$.role\') AS role FROM nodes WHERE task_id=? ORDER BY rowid')
    .all(taskId) as { id: string; status: string; role: string | null }[];
  return rows.map(row => ({ id: row.id, status: row.status, role: row.role }));
}

/** How to describe a peer to the model, so it knows what it may address. */
export function renderPeers(peers: PeerNode[], self: string): string {
  const others = peers.filter(peer => peer.id !== self);
  if (others.length === 0) return '这张图里目前只有你自己。';
  return others.map(peer => `${peer.id}（${peer.role ?? 'agent'}，${peer.status}）`).join('、');
}
