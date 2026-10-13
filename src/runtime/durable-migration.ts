import { join } from 'node:path';
import type { TaskStore } from '../core/store.ts';
import type { DurableHost } from './durable-host.ts';
import { legacyHistory } from './durable-history.ts';

/** Complete passive conversion before any main or node can enable the scheduler.
 * Visible messages and the existing accounting ledger remain Graph-owned. */
export async function importMainHistories(store: TaskStore, host: DurableHost, instancesDir: string): Promise<void> {
  const mains = store.db.prepare(`SELECT i.id,i.definition_version,i.used,
    EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('assistant','tool','activity')) AS has_history FROM conversations c
    JOIN instances i ON i.task_id=c.anchor_task_id AND i.node_id='master'
    ORDER BY c.created_seq`).all() as { id: string; definition_version: string | null; used: number; has_history: number }[];
  const prepared: { identity: string; init: Awaited<ReturnType<typeof legacyHistory>> }[] = [];
  // Validate every source before creating any durable identity. A missing or
  // corrupt later file must not silently turn a retained conversation empty.
  for (const main of mains) {
    if (await host.findConversation(main.id)) continue;
    const init = await legacyHistory({ binding: { instanceId: main.id, nodeId: 'master', definitionVersion: main.definition_version ?? '' }, stateDir: join(instancesDir, main.id) });
    if (!init && (main.used > 0 || main.has_history)) throw new Error('Legacy main history source is missing; migration is parked to preserve the conversation');
    if (init) prepared.push({ identity: main.id, init });
  }
  for (const source of prepared) await host.conversation(source.identity, { instructions: '' }, source.init);
}
