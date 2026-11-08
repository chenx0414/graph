// graph:table-writes-exempt: the test seeds the deferred rows the limit counts
package graph

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func newDeferredTestStore(t *testing.T) (*TaskStore, func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	return store, func() { store.Close() }
}

func seedDeferredCall(t *testing.T, store *TaskStore, conversationId, id string) {
	t.Helper()
	_, created := RecordDeferredToolCall(store, DeferredToolCallInput{
		TaskId: "task", ConversationId: conversationId, NodeId: "node", ExecutionId: "exec",
		OperationId: "exec", ToolName: "bash", RequestId: id, RequestDigest: "digest-" + id,
		Args: "bash sleep 60", Summary: "sleep 60", StartedAt: NowMillis(),
	})
	if !created {
		t.Fatalf("seed %s: not recorded", id)
	}
}

func TestConversationRefusesBackgroundCallsPastItsLimit(t *testing.T) {
	store, closeStore := newDeferredTestStore(t)
	defer closeStore()

	for index := 0; index < DeferredToolCallsPerConversation; index++ {
		seedDeferredCall(t, store, "conversation", "call-"+string(rune('a'+index)))
	}
	if err := DeferredToolCallSlot(store, "conversation"); err == nil {
		t.Fatalf("a conversation at its limit still accepted another background call")
	} else if !strings.Contains(err.Error(), "background") {
		t.Fatalf("the refusal does not say what is full: %v", err)
	}

	if err := DeferredToolCallSlot(store, "other-conversation"); err != nil {
		t.Fatalf("the limit leaked into another conversation: %v", err)
	}

	settled := DeferredToolCallsOfConversation(store, "conversation")[0]
	FinishDeferredToolCall(store, settled.Id, DeferredToolSettled, "", "here is the output", NowMillis())
	if err := DeferredToolCallSlot(store, "conversation"); err != nil {
		t.Fatalf("a settled call still counts against the limit: %v", err)
	}
}

func seedCallAt(t *testing.T, store *TaskStore, conversationId, id string, startedAt int64, state DeferredToolCallState) {
	t.Helper()
	row, created := RecordDeferredToolCall(store, DeferredToolCallInput{
		TaskId: "task", ConversationId: conversationId, NodeId: "node", ExecutionId: "exec",
		OperationId: "exec", ToolName: "bash", RequestId: id, RequestDigest: "digest-" + id,
		Args: "bash sleep 60", Summary: "sleep 60", StartedAt: startedAt,
	})
	if !created {
		t.Fatalf("seed %s: not recorded", id)
	}
	if state != DeferredToolAccepted {
		FinishDeferredToolCall(store, row.Id, state, "", "done", startedAt+1000)
	}
}

func TestExpiredFinishedCallsAreReapedWhileLiveOnesSurvive(t *testing.T) {
	store, closeStore := newDeferredTestStore(t)
	defer closeStore()

	now := NowMillis()
	seedCallAt(t, store, "conversation", "old-finished", now-DeferredToolCallRetentionMs-60_000, DeferredToolSettled)
	seedCallAt(t, store, "conversation", "fresh-finished", now-1_000, DeferredToolSettled)
	seedCallAt(t, store, "conversation", "old-running", now-DeferredToolCallRetentionMs-60_000, DeferredToolAccepted)

	removed := ReapDeferredToolCalls(store, now)
	if removed != 1 {
		t.Fatalf("reaped %d rows, want exactly the one finished call past its retention", removed)
	}

	ids := map[string]bool{}
	for _, call := range DeferredToolCallsOfConversation(store, "conversation") {
		ids[call.RequestId] = true
	}
	if ids["old-finished"] {
		t.Fatalf("a finished call past its retention was not reaped")
	}
	if !ids["fresh-finished"] {
		t.Fatalf("a finished call inside its retention was reaped")
	}
	if !ids["old-running"] {
		t.Fatalf("a live call was reaped; the row is what makes it observable")
	}
}
