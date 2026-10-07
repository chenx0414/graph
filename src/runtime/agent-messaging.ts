import { type TaskStore } from '../core/store.ts';

/** Address-list helpers for the existing Pi adapter. Native message delivery uses
 * kernel-node-messages.ts: every message queues a serial turn on the recipient's
 * existing session. The native lane supplies its own graph-scoped address list;
 * the external main agent receives peer chat in its owning conversation. */

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
