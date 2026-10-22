package graph

// RetireLegacyGraphs stops pre-interface dispatch without deleting its historical identities.
// ADR 0031 preserves drafts, artifacts, worktrees and accounting provenance.
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
		// Retain every source identity, draft, artifact and accounting record.
		// A stopped task fences its former dispatcher without deleting provenance:
		// the user's own work, the artifacts they published and what the run
		// cost them stay readable after the upgrade.
		for _, row := range candidates {
			if row["id"] == nil {
				panic("retired graph id is null")
			}
			id := row["id"]
			kernelExec(store.DB, "UPDATE tasks SET phase='stopped',paused=1 WHERE id=? AND phase NOT IN ('completed','discussing','stopped')", id)
			kernelExec(store.DB, "UPDATE tasks SET paused=1 WHERE id=?", id)
			kernelExec(store.DB, "UPDATE runtime SET active_task=NULL WHERE active_task=?", id)
			kernelExec(store.DB, "UPDATE operations SET worker_active=0 WHERE task_id=?", id)
		}
		return nil
	})
}
