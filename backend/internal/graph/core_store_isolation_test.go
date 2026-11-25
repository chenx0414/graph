// graph:table-writes-exempt: the test seeds and reads the rows an isolation check needs
package graph

import (
	"path/filepath"
	"sync"
	"testing"
)

// A transaction owns its connection. A statement from another goroutine must wait for it rather
// than run on it: with BEGIN issued as a plain statement on the shared pool, the next goroutine to
// borrow that connection ran inside the open transaction, so a write from a goroutine that never
// joined a transaction was rolled back with it.
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

// The transaction's own statements must land on the connection it owns, so a body that writes
// through the handle it was given sees its own uncommitted rows while another goroutine does not.
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

// Two goroutines that never join each other's transaction must both keep their writes: each
// transaction owns its own connection, and a plain write outside any transaction joins neither.
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
