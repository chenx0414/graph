import type { TaskStore } from './store.ts';

/** ADR 0030: discard DAG records before recovery or model binding. Keep native
 * graphs and conversation anchors, which own the external main's session. */
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
    // Circular instance/budget and node/operation references must disappear in
    // one transaction. COMMIT still enforces every foreign key.
    // Retained main handoffs/resolutions can be large. SQLite checks these
    // child references even with deferred constraints; index the lookup keys
    // before deleting thousands of old parent operations and handoffs.
    store.db.exec(`PRAGMA defer_foreign_keys=ON;
      CREATE INDEX IF NOT EXISTS context_handoffs_operation ON context_handoffs(operation_id);
      CREATE INDEX IF NOT EXISTS context_resolutions_handoff ON context_resolutions(handoff_id);
      CREATE TEMP TABLE retired_graphs(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE retired_operations(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE retired_instances(id TEXT PRIMARY KEY);`);
    const insert = store.db.prepare('INSERT INTO retired_graphs VALUES(?)');
    for (const row of candidates) insert.run(row.id!);
    store.db.exec(`
      INSERT INTO retired_operations SELECT id FROM operations WHERE task_id IN (SELECT id FROM retired_graphs);
      INSERT INTO retired_instances SELECT id FROM instances WHERE task_id IN (SELECT id FROM retired_graphs);
      UPDATE runtime SET active_task=NULL WHERE active_task IN (SELECT id FROM retired_graphs);
      DELETE FROM node_sessions WHERE instance_id IN (SELECT id FROM retired_instances);
      DELETE FROM invocations WHERE operation_id IN (SELECT id FROM retired_operations)
        OR instance_id IN (SELECT id FROM retired_instances);
      DELETE FROM messages WHERE operation_id IN (SELECT id FROM retired_operations);
      DELETE FROM artifact_links WHERE artifact_id IN
        (SELECT artifact_id FROM artifacts WHERE task_id IN (SELECT id FROM retired_graphs));
      DELETE FROM commands WHERE json_extract(payload,'$.taskId') IN (SELECT id FROM retired_graphs)
        OR json_extract(receipt,'$.taskId') IN (SELECT id FROM retired_graphs)
        OR scope IN (SELECT 'supervisor:' || id FROM retired_graphs)
        OR scope IN (SELECT 'human-review:' || id FROM retired_graphs)
        OR scope IN (SELECT 'problems:' || id FROM retired_graphs);
    `);
    // Task ownership is the common storage boundary, including Git logs,
    // published artifact metadata, questions, calls and context records.
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    // Later-created tables hold child references to the earlier operation and
    // instance records. Delete those children first so each parent deletion
    // does not scan retained main history for deferred foreign-key checks.
    for (const row of tables.reverse()) {
      const name = `"${String(row.name).replaceAll('"', '""')}"`;
      const columns = store.db.prepare(`PRAGMA table_info(${name})`).all();
      if (columns.some(column => column.name === 'task_id')) {
        store.db.exec(`DELETE FROM ${name} WHERE task_id IN (SELECT id FROM retired_graphs)`);
      }
    }
    store.db.exec(`DELETE FROM tasks WHERE id IN (SELECT id FROM retired_graphs);
      DROP TABLE retired_operations; DROP TABLE retired_instances; DROP TABLE retired_graphs;`);
  });
}
