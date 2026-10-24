package graph

// graph:table-writes-exempt: retiring a graph and everything of it is one fact about many tables

import "strings"

// RetireLegacyGraphs discards DAG records before recovery or model binding.
// Native graphs and conversation anchors are kept.
func RetireLegacyGraphs(store *TaskStore) {
	candidates := kernelRows(store.DB, `SELECT t.id FROM tasks t
    WHERE NOT EXISTS (SELECT 1 FROM kernel_revisions k WHERE k.task_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.anchor_task_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kernel_graph_owners o WHERE o.owner_task_id=t.id)
      AND (EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=t.id AND n.id!='master')
        OR EXISTS (SELECT 1 FROM graph_revisions r WHERE r.task_id=t.id)
        OR EXISTS (SELECT 1 FROM proposals p WHERE p.task_id=t.id
          AND json_extract(p.spec,'$.definition') IS NULL))`)
	if len(candidates) == 0 {
		return
	}
	store.Transaction(func() any {
		kernelExec(store.DB, `PRAGMA defer_foreign_keys=ON;
      CREATE INDEX IF NOT EXISTS context_handoffs_operation ON context_handoffs(operation_id);
      CREATE INDEX IF NOT EXISTS context_resolutions_handoff ON context_resolutions(handoff_id);
      CREATE TEMP TABLE retired_graphs(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE retired_operations(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE retired_instances(id TEXT PRIMARY KEY);`)
		for _, row := range candidates {
			if row["id"] == nil {
				panic("retired graph id is null")
			}
			kernelExec(store.DB, "INSERT INTO retired_graphs VALUES(?)", row["id"])
		}
		kernelExec(store.DB, `
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
    `)
		tables := kernelRows(store.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
		for i, j := 0, len(tables)-1; i < j; i, j = i+1, j-1 {
			tables[i], tables[j] = tables[j], tables[i]
		}
		for _, row := range tables {
			name := `"` + strings.ReplaceAll(kernelString(row["name"]), `"`, `""`) + `"`
			columns := kernelRows(store.DB, "PRAGMA table_info("+name+")")
			hasTask := false
			for _, column := range columns {
				if kernelString(column["name"]) == "task_id" {
					hasTask = true
					break
				}
			}
			if hasTask {
				kernelExec(store.DB, "DELETE FROM "+name+" WHERE task_id IN (SELECT id FROM retired_graphs)")
			}
		}
		kernelExec(store.DB, `DELETE FROM tasks WHERE id IN (SELECT id FROM retired_graphs);
      DROP TABLE retired_operations; DROP TABLE retired_instances; DROP TABLE retired_graphs;`)
		return nil
	})
}
