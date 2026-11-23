// graph:table-writes-exempt: a test seeds the invocation rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestInvocationTotalsFollowSettledWrites(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-totals-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task','p','r',1,0,1,'completed')")
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec) VALUES('task','master',?)", `{"role":"master"}`)
	store.RecordOperationIntent("op", "task", "master", nil, 1, "{}", 0, "")
	store.OpenInvocation("inv", "op", "inst", "m", "completion")

	runtime := &TaskRuntime{store: store, kernel: NewKernelStore(store)}
	cost := taskRuntimeTaskCost(runtime, "task")
	if !cost.Unknown || len(cost.Amounts) != 0 {
		t.Fatalf("an unsettled invocation is unknown and costless, got %+v", cost)
	}
	store.RecordInvocationUsage("inv", `{"input":100,"output":10,"cacheRead":900,"cacheWrite":0,"contextTokens":1000}`,
		`{"amount":0.5,"currency":"USD","unit":"per_million_tokens"}`)

	cost = taskRuntimeTaskCost(runtime, "task")
	if cost.Unknown || cost.Amount == nil || *cost.Amount != 0.5 {
		t.Fatalf("the settled cost is known, got %+v", cost)
	}
	usage := ConversationMasterUsage(store, "")
	_ = usage
	store.RecordInvocationUsage("inv", `{"input":200,"output":20,"cacheRead":800,"cacheWrite":0,"contextTokens":1000}`,
		`{"amount":0.7,"currency":"USD","unit":"per_million_tokens"}`)
	cost = taskRuntimeTaskCost(runtime, "task")
	if cost.Amount == nil || *cost.Amount != 0.7 {
		t.Fatalf("a re-settled invocation replaces its old cost, got %+v", cost)
	}
}

func TestTaskCostUsesThePersistedTotalsInsteadOfRescanningInvocations(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-totals-cache','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task','p','r',1,0,1,'completed')")
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec) VALUES('task','master',?)", `{"role":"master"}`)
	store.RecordOperationIntent("op", "task", "master", nil, 1, "{}", 0, "")
	store.OpenInvocation("inv", "op", "inst", "m", "completion")
	store.RecordInvocationUsage("inv", `{"input":100,"output":10}`,
		`{"amount":0.5,"currency":"USD","unit":"per_million_tokens"}`)

	runtime := &TaskRuntime{store: store, kernel: NewKernelStore(store)}
	before := taskRuntimeTaskCost(runtime, "task")
	kernelExec(store.DB, "DELETE FROM invocations")
	after := taskRuntimeTaskCost(runtime, "task")
	if after.Amount == nil || before.Amount == nil || *after.Amount != *before.Amount {
		t.Fatalf("the cache keeps the settled cost without the rows, before %+v after %+v", before, after)
	}
}
