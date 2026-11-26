package graph

import (
	"path/filepath"
	"testing"
	"time"
)

// A daemon start recovers the operations a previous process left behind, and it
// does so inside one transaction. The pool is a single connection, so anything
// the recovery calls that opens a second one waits for a connection that the
// transaction is holding: the daemon never finishes starting.
//
// Measured 2026-11-26: a dispatched operation was on disk, Recover held the only
// connection, restoreUnsentConversation asked the adapter whether the turn could
// be replayed, and the adapter's own query waited on the pool forever. The only
// way out was to mark the operation failed by hand.
//
// This test is the shape of that hang: the recovery path must finish while the
// transaction owns the pool.
func TestRecoveringADispatchedOperationDoesNotWaitForItsOwnTransaction(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	NewKernelStore(store)
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/recovery-deadlock','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'chatting')")
	// A delivered user message, a master node on the same activation, and a
	// dispatched operation: the shape restoreUnsentConversation recognises.
	kernelExec(store.DB, `INSERT INTO nodes(task_id,id,spec,status,activation_id)
		VALUES('t','master','{"role":"master"}','pending','a')`)
	kernelExec(store.DB, `INSERT INTO operations(id,task_id,node_id,state,generation,spec,reserved,activation_id)
		VALUES('op','t','master','dispatched',1,'{"Id":"op","Action":"chat"}',0,'a')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	kernelExec(store.DB, "UPDATE tasks SET phase='chatting', conversation_id='c' WHERE id='t'")
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,text,state,operation_id,created_at,updated_at)
		VALUES('m1','c','user','chat','hello','delivered','op',0,0)`)

	// The hook stands in for the pi adapter's CanReplayBeforeSend: it asks the
	// store a question of its own, exactly as the adapter does.
	asked := make(chan struct{})
	lifecycle := NewOperationLifecycle(store, OperationLifecycleHooks{
		CanReplayBeforeSend: func(store *TaskStore, operation Operation) bool {
			close(asked)
			graphDBRow(store.Db, "SELECT 1 FROM node_capabilities WHERE operation_id=? LIMIT 1", operation.Id)
			return false
		},
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		lifecycle.Recover()
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		select {
		case <-asked:
			t.Fatal("recovery holds the only connection and then asks the pool for another: it waits forever, and a daemon with an unfinished operation never starts")
		default:
			t.Fatal("recovery did not finish")
		}
	}
}

// The same recovery must still do its job: an operation dispatched by a process
// that is gone is reconciled, not left dangling. A fix that only makes the
// query not hang would be a fix that stops recovering.
func TestRecoveryStillSettlesTheDispatchedOperation(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	NewKernelStore(store)
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/recovery-settles','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'chatting')")
	// A delivered user message, a master node on the same activation, and a
	// dispatched operation: the shape restoreUnsentConversation recognises.
	kernelExec(store.DB, `INSERT INTO nodes(task_id,id,spec,status,activation_id)
		VALUES('t','master','{"role":"master"}','pending','a')`)
	kernelExec(store.DB, `INSERT INTO operations(id,task_id,node_id,state,generation,spec,reserved,activation_id)
		VALUES('op','t','master','dispatched',1,'{"Id":"op","Action":"chat"}',0,'a')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	kernelExec(store.DB, "UPDATE tasks SET phase='chatting', conversation_id='c' WHERE id='t'")
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,text,state,operation_id,created_at,updated_at)
		VALUES('m1','c','user','chat','hello','delivered','op',0,0)`)

	lifecycle := NewOperationLifecycle(store, OperationLifecycleHooks{
		CanReplayBeforeSend: func(*TaskStore, Operation) bool { return false },
	})
	lifecycle.Recover()

	row := kernelRow(store.Db, "SELECT state FROM operations WHERE id='op'")
	if row == nil {
		t.Fatal("recovery must not delete the operation it reconciled")
	}
	if state := kernelString(row["state"]); state == "dispatched" {
		t.Fatalf("an operation whose worker is gone must not stay dispatched, got %q", state)
	}
}
