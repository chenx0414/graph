// graph:table-writes-exempt: the test drives the failure path and writes no table
package graph

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// A transaction whose COMMIT fails must report the commit. The deferred ROLLBACK used to run
// anyway; with no transaction left to end it panicked with "cannot rollback - no transaction is
// active", which is exactly what the async full run of 4c4c9478 reported instead of the
// SQLITE_BUSY that had actually happened. One sentence about a rollback that could not happen
// sent two separate investigations in the wrong direction.
func TestAFailedCommitIsReportedAsACommitFailure(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	commitErr := errors.New("database is locked (5) (SQLITE_BUSY)")
	// A failed COMMIT ends the transaction, so a ROLLBACK after it reports that there is none
	// left - the real SQLite answer that used to become the panic message.
	ended := false
	store.transactionExec = func(statement string) error {
		switch {
		case strings.HasPrefix(statement, "COMMIT"):
			ended = true
			return commitErr
		case strings.HasPrefix(statement, "ROLLBACK") && ended:
			return errors.New("SQL logic error: cannot rollback - no transaction is active (1)")
		}
		return nil
	}

	recovered := recoverOf(func() { store.Transaction(func(tx *TaskStore) any { return "work" }) })
	if recovered == nil {
		t.Fatalf("a transaction that cannot commit must not report success")
	}
	message := errorText(recovered)
	if !strings.Contains(message, "SQLITE_BUSY") {
		t.Fatalf("the failure must carry the reason the commit failed, got %q", message)
	}
	if strings.Contains(message, "cannot rollback") {
		t.Fatalf("the failure must not name a rollback that could not happen, got %q", message)
	}
}

// The other half of the same contract: when the action itself fails, the transaction is still
// rolled back, because there it really is open.
func TestAFailedActionStillRollsBack(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	rolledBack := false
	store.transactionExec = func(statement string) error {
		if strings.HasPrefix(statement, "ROLLBACK") {
			rolledBack = true
		}
		return nil
	}
	recovered := recoverOf(func() {
		store.Transaction(func(tx *TaskStore) any { panic("the action failed") })
	})
	if recovered == nil {
		t.Fatalf("an action that panics must not report success")
	}
	if !rolledBack {
		t.Fatalf("a transaction whose action failed is rolled back")
	}
}

func recoverOf(run func()) (recovered any) {
	defer func() { recovered = recover() }()
	run()
	return nil
}

func errorText(value any) string {
	switch typed := value.(type) {
	case error:
		return typed.Error()
	case string:
		return typed
	}
	return ""
}
