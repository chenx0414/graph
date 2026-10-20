import type { TaskStore } from './store.ts';

/** Retire pre-interface dispatch without deleting its historical identities.
 * ADR 0031 preserves drafts, artifacts, worktrees and accounting provenance. */
export function retireLegacyGraphs(store: TaskStore): void {
  const candidates = store.db.prepare(`SELECT t.id FROM tasks t
    WHERE NOT EXISTS (SELECT 1 FROM kernel_revisions k WHERE k.task_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.anchor_task_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kernel_graph_owners o WHERE o.owner_task_id=t.id)
      AND (EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=t.id AND n.id!='master')
        OR EXISTS (SELECT 1 FROM graph_revisions r WHERE r.task_id=t.id)
        OR EXISTS (SELECT 1 FROM proposals p WHERE p.task_id=t.id
          AND json_extract(p.spec,'$.definition') IS NULL))`).all();
  if (!candidates.length) return;
  store.transaction(() => {
    // Retain every source identity, draft, artifact and accounting record.
    // A stopped task fences its former dispatcher without deleting provenance.
    for (const row of candidates) {
      store.db.prepare("UPDATE tasks SET phase='stopped',paused=1 WHERE id=? AND phase NOT IN ('completed','discussing','stopped')").run(row.id!);
      store.db.prepare("UPDATE tasks SET paused=1 WHERE id=?").run(row.id!);
      store.db.prepare('UPDATE runtime SET active_task=NULL WHERE active_task=?').run(row.id!);
      store.db.prepare('UPDATE operations SET worker_active=0 WHERE task_id=?').run(row.id!);
    }
  });
}

/** One exclusive cutover fence. Later startups must not retire durable work.
 * Keep definitions and all provenance; only pre-cutover dispatch is cancelled. */
export function retirePreDurableExecutions(store: TaskStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS kernel_cutovers(
    kernel TEXT PRIMARY KEY, graph_ids TEXT NOT NULL, completed_at INTEGER NOT NULL)`);
  if (store.db.prepare('SELECT 1 FROM kernel_cutovers WHERE kernel=?').get('pi-durable@1.1.0')) return;
  store.transaction(() => {
    const graphs = store.db.prepare(`SELECT DISTINCT k.task_id FROM kernel_revisions k
      WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.anchor_task_id=k.task_id)`).all() as { task_id: string }[];
    for (const { task_id: id } of graphs) {
      store.db.prepare("UPDATE tasks SET phase='blocked',paused=1 WHERE id=? AND phase NOT IN ('completed','discussing','stopped')").run(id);
      store.db.prepare("UPDATE kernel_queue SET state='done',reason='retired by pi-durable cutover' WHERE task_id=? AND state IN ('queued','claimed','failed')").run(id);
      store.db.prepare("UPDATE kernel_executions SET state='blocked',waiting_slot=0,ended_at=? WHERE task_id=? AND state='running'").run(Date.now(), id);
      // Retain reservations and unknown usage. Cancellation is not proof that
      // an already-dispatched provider or external tool had zero effect.
      store.db.prepare("UPDATE kernel_provider_calls SET state='unknown' WHERE task_id=? AND state='inflight'").run(id);
      store.db.prepare("UPDATE kernel_module_operations SET state='uncertain',error='Retired after dispatch by pi-durable cutover' WHERE task_id=? AND state='dispatched'").run(id);
      store.db.prepare("UPDATE kernel_module_operations SET state='cancelled',worker_active=0 WHERE task_id=? AND state='prepared'").run(id);
      store.db.prepare('UPDATE kernel_module_inbox SET processed=1 WHERE task_id=? AND processed=0').run(id);
      store.db.prepare(`UPDATE kernel_transition_outbox SET routed=1 WHERE routed=0 AND transition_id IN
        (SELECT id FROM kernel_module_transitions WHERE task_id=?)`).run(id);
      store.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND status='running'").run(id);
      store.db.prepare('UPDATE runtime SET active_task=NULL WHERE active_task=?').run(id);
    }
    store.db.prepare('INSERT INTO kernel_cutovers VALUES(?,?,?)').run('pi-durable@1.1.0', JSON.stringify(graphs.map(graph => graph.task_id)), Date.now());
  });
}
