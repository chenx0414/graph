// graph:table-writes-exempt: a test seeds the interrupted execution it recovers
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestKernelRecoveryStillFindsAnInterruptedExecution(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	kernel := NewKernelStore(store)
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/kernel-recovery','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'chatting')")
	kernelExec(kernel.Db, `INSERT INTO kernel_executions(id,task_id,node_id,revision_version,state,started_at)
		VALUES('e','t','master',1,'running',1)`)
	interrupted := RecoverKernelExecutions(kernel)
	if len(interrupted) != 1 || interrupted[0] != "e" {
		t.Fatalf("the interrupted execution is reported, got %v", interrupted)
	}
	state := kernelString(kernelRow(kernel.Db, "SELECT state FROM kernel_executions WHERE id='e'")["state"])
	if state != "blocked" {
		t.Fatalf("an execution without a submission is blocked for reconciliation, got %s", state)
	}
}

func TestKernelRecoveryStaysEmptyWhenNothingWasInterrupted(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	if interrupted := RecoverKernelExecutions(NewKernelStore(store)); len(interrupted) != 0 {
		t.Fatalf("a clean store has nothing to recover, got %v", interrupted)
	}
}

func TestKernelRecoveryProbeUsesTheProviderStateIndex(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	NewKernelStore(store)
	rows := kernelRows(store.DB, "EXPLAIN QUERY PLAN SELECT 1 FROM kernel_provider_calls WHERE state='inflight' LIMIT 1")
	detail := ""
	for _, row := range rows {
		detail += kernelString(row["detail"])
	}
	if !strings.Contains(detail, "kernel_provider_calls_state") {
		t.Fatalf("the recovery probe must use the provider-state index, got %s", detail)
	}
}
