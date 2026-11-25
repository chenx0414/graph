// graph:table-writes-exempt: the test seeds and reads the rows an isolation check needs
package graph

import (
	"path/filepath"
	"sync"
	"testing"
)

// Another goroutine's write must wait for the transaction rather than run inside it and be rolled back with it.
func TestAnotherGoroutinesWriteIsNotSwallowedByAnOpenTransaction(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "isolation.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/isolation','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'working')")

	inside := make(chan struct{})
	finish := make(chan struct{})
	foreignDone := make(chan struct{})
	go func() {
		defer func() { _ = recover() }()
		store.Transaction(func(tx *TaskStore) any {
			kernelExec(tx.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','inside.tx','{}',1)")
			close(inside)
			<-finish
			panic("this transaction rolls back")
		})
	}()
	go func() {
		<-inside
		kernelExec(store.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','outside.tx','{}',2)")
		close(foreignDone)
	}()

	<-inside
	select {
	case <-foreignDone:
		t.Fatalf("another goroutine wrote on the connection the open transaction owns")
	default:
	}
	close(finish)

	<-foreignDone
	if survived := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type='outside.tx'")["c"]); survived != 1 {
		t.Fatalf("a write from another goroutine was rolled back with a transaction it never joined: %d row(s)", survived)
	}
	if rolledBack := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type='inside.tx'")["c"]); rolledBack != 0 {
		t.Fatalf("the transaction's own row survived its rollback: %d row(s)", rolledBack)
	}
}

// A body sees its own uncommitted rows through the handle it was given.
func TestATransactionBodySeesItsOwnUncommittedRows(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "isolation-own.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/isolation-own','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'working')")

	seen := store.Transaction(func(tx *TaskStore) any {
		kernelExec(tx.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','own.row','{}',1)")
		return kernelInt(kernelRow(tx.DB, "SELECT COUNT(*) AS c FROM events WHERE type='own.row'")["c"])
	})
	if kernelInt(seen) != 1 {
		t.Fatalf("the body could not see its own uncommitted row, saw %v", seen)
	}
	if committed := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type='own.row'")["c"]); committed != 1 {
		t.Fatalf("the committed row is not readable through the pool, got %d", committed)
	}
}

// Two transactions and a plain writer must each keep every row.
func TestConcurrentTransactionsAndPlainWritesKeepEveryRow(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "isolation-concurrent.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/isolation-concurrent','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'working')")

	const rounds = 24
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			store.Transaction(func(tx *TaskStore) any {
				kernelExec(tx.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','tx.a','{}',1)")
				return nil
			})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			store.Transaction(func(tx *TaskStore) any {
				kernelExec(tx.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','tx.b','{}',2)")
				return nil
			})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			kernelExec(store.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','plain','{}',3)")
		}
	}()
	wg.Wait()

	for _, kind := range []string{"tx.a", "tx.b", "plain"} {
		got := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type=?", kind)["c"])
		if got != rounds {
			t.Fatalf("%s kept %d of %d rows", kind, got, rounds)
		}
	}
}

// A nested transaction and a kernel rebuilt from the handle join the open transaction instead of waiting on it.
func TestNestedTransactionsJoinInsteadOfWaiting(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "isolation-nested.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/isolation-nested','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','r',1,'working')")
	kernel := NewKernelStore(store)

	store.Transaction(func(tx *TaskStore) any {
		tx.Event("t", "outer", map[string]any{"n": 1})
		// A nested transaction through the same handle joins this one.
		tx.Transaction(func(inner *TaskStore) any {
			inner.Event("t", "inner", map[string]any{"n": 2})
			return nil
		})
		// A kernel rebuilt from the handle writes on the same connection.
		NewKernelStore(tx).Store.Event("t", "kernel", map[string]any{"n": 3})
		return nil
	})
	for _, kind := range []string{"outer", "inner", "kernel"} {
		if got := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type=?", kind)["c"]); got != 1 {
			t.Fatalf("%s kept %d row(s)", kind, got)
		}
	}
	if kernel.Store.InTransaction() {
		t.Fatal("the pool store must be outside the transaction once it has ended")
	}
}
