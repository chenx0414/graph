// graph:table-writes-exempt: a test seeds the invocation rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

func seedMasterCompletion(t *testing.T, store *TaskStore, conversationId, operationId string, usage string, settledAt int64) {
	t.Helper()
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,1,0,?,?)",
		"task-"+operationId, "p", conversationId, "r", 1, "completed")
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec) VALUES(?,?,?)", "task-"+operationId, "master", `{"role":"master"}`)
	store.RecordOperationIntent(operationId, "task-"+operationId, "master", nil, 1, "{}", 0, "")
	kernelExec(store.DB, "UPDATE operations SET state='settled',settled_at=?,dispatched_at=? WHERE id=?", settledAt, settledAt-1000, operationId)
	store.OpenInvocation("inv-"+operationId, operationId, "inst", "m", "completion")
	kernelExec(store.DB, "UPDATE invocations SET usage=?,settled_at=?,dispatched_at=? WHERE id=?", usage, settledAt, settledAt-1000, "inv-"+operationId)
}

func TestContextTokensReadTheEstimateRatherThanTheCompactionRequestInput(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-summary-fixture','[]')")
	seedMasterCompletion(t, store, "conv", "op-turn", `{"input":5000,"output":100,"cacheRead":595000,"cacheWrite":0,"contextTokens":600000}`, 1000)
	seedMasterCompletion(t, store, "conv", "op-compact", `{"input":285219,"output":2953,"cacheRead":0,"cacheWrite":0,"contextTokens":55300}`, 2000)

	usage := ConversationMasterUsage(store, "conv")
	if usage.ContextTokens == nil {
		t.Fatalf("the view reported no context size")
	}
	if got := *usage.ContextTokens; got != 55300 {
		t.Fatalf("the context size must be the post-turn estimate, not the compaction request's input: got %d", got)
	}
}

func TestCacheHitRateDescribesTheSameRequestAsTheTokenCount(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-summary-fixture','[]')")
	seedMasterCompletion(t, store, "conv", "op-first", `{"input":285219,"output":2953,"cacheRead":0,"cacheWrite":0}`, 1000)
	seedMasterCompletion(t, store, "conv", "op-second", `{"input":34680,"output":248,"cacheRead":20480,"cacheWrite":0}`, 2000)

	view := ConversationMasterUsage(store, "conv")
	if view.CacheReadTokens == nil || *view.CacheReadTokens != 20480 {
		t.Fatalf("the token count must come from the newest request: %v", view.CacheReadTokens)
	}
	if view.RequestCacheHitRate == nil {
		t.Fatalf("the view reported no per-request cache rate")
	}
	want := 20480.0 / (20480.0 + 34680.0)
	if diff := *view.RequestCacheHitRate - want; diff > 0.0001 || diff < -0.0001 {
		t.Fatalf("the rate must describe the newest request (%v), got %v", want, *view.RequestCacheHitRate)
	}
}
