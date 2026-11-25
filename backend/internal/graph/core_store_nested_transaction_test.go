package graph

import (
	"path/filepath"
	"testing"
)

func TestRecoveryInsideATransactionDoesNotDeadlock(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p", t.TempDir(), "[]")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t1','p','probe',1)")
	kernel := NewKernelStore(store)

	recovered := false
	store.Transaction(func(tx *TaskStore) any {
		tx.Event("t1", "during", map[string]any{"n": 1})
		func() {
			defer func() {
				if r := recover(); r != nil {
					kernel := NewKernelStore(tx)
					kernel.SetNodeQueuePaused("t1", "n1", true)
					kernel.BlockNode("t1", "n1", panicMessage(r))
					recovered = true
				}
			}()
			panic("the node blew up")
		}()
		return nil
	})
	if !recovered {
		t.Fatal("the recovery path never ran")
	}
	if paused := kernel.NodeState("t1", "n1"); !paused.Paused {
		t.Fatal("the recovered node must stay paused")
	}
}
