// graph:table-writes-exempt: a test seeds the invocation rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestTaskCostAddsTheSameInvocationCostsWithoutLoadingEveryRow(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-cost-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task','p','r',1,0,1,'completed')")
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec) VALUES('task','master',?)", `{"role":"master"}`)

	seed := func(id, operation, cost string) {
		store.RecordOperationIntent(operation, "task", "master", nil, 1, "{}", 0, "")
		kernelExec(store.DB, "UPDATE operations SET state='settled',settled_at=1000,dispatched_at=0 WHERE id=?", operation)
		store.OpenInvocation(id, operation, "inst", "m", "completion")
		kernelExec(store.DB, "UPDATE invocations SET cost=? WHERE id=?", cost, id)
	}
	seed("inv-a", "op-a", `{"amount":0.5,"currency":"USD","unit":"per_million_tokens"}`)
	seed("inv-b", "op-b", `{"amount":0.25,"currency":"USD","unit":"per_million_tokens"}`)
	seed("inv-c", "op-c", `{"unknown":true}`)

	runtime := &TaskRuntime{store: store, kernel: NewKernelStore(store)}
	cost := taskRuntimeTaskCost(runtime, "task")
	if !cost.Unknown {
		t.Fatalf("an unknown invocation keeps the total unknown, got %+v", cost)
	}
	if cost.Amount == nil || *cost.Amount != 0.75 {
		t.Fatalf("the known amounts still add up, got %+v", cost)
	}
	if cost.Currency == nil || *cost.Currency != "USD" {
		t.Fatalf("the currency stays USD, got %+v", cost)
	}
}
