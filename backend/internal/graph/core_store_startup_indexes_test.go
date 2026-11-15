package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupRecoveryQueriesUseTheirIndexes(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	plan := func(query string) string {
		rows := kernelRows(store.DB, "EXPLAIN QUERY PLAN "+query)
		lines := []string{}
		for _, row := range rows {
			lines = append(lines, kernelString(row["detail"]))
		}
		return strings.Join(lines, "\n")
	}
	slots := plan("SELECT id FROM operations WHERE instance_id IS NOT NULL AND (state='intent' OR (worker_active=1 AND waiting_slot=0))")
	if !strings.Contains(slots, "operations_intent") || !strings.Contains(slots, "operations_worker") {
		t.Fatalf("the startup slot rebuild must search its partial indexes, got %s", slots)
	}
	queue := plan("SELECT DISTINCT c.anchor_task_id FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE c.archived_at IS NULL AND m.role='user' AND m.state IN ('pending','queued')")
	if !strings.Contains(queue, "messages_queue") {
		t.Fatalf("the startup queued-message dispatch must search messages_queue, got %s", queue)
	}
}
