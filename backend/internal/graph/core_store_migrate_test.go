// graph:table-writes-exempt: a test seeds the rows it reopens around
package graph

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func openTaskStore(t *testing.T, path string) *TaskStore {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return NewTaskStore(db, path)
}

func hasColumn(t *testing.T, store *TaskStore, table, column string) bool {
	t.Helper()
	rows, err := store.DB.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("table_info %s: %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == column {
			return true
		}
	}
	return false
}

// A database written by a newer build cannot be downgraded: the runtime refuses
// it instead of silently writing rows the current schema does not describe.
func TestMigrationRefusesADatabaseFromANewerRuntime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	store := openTaskStore(t, path)
	if _, err := store.DB.Exec("PRAGMA user_version=" + itoa(SCHEMA_VERSION+1)); err != nil {
		t.Fatalf("raise user_version: %v", err)
	}
	store.Close()

	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("opening a newer database must be refused")
		}
		if message := kernelString(asMap(recovered)["message"]); message != "" && !strings.Contains(message, "newer runtime") {
			t.Fatalf("the refusal has to say why, got %q", message)
		}
	}()
	openTaskStore(t, path)
}

// Opening the same database twice is how every restart of the daemon happens:
// the second run must be a no-op, not a second attempt at the same schema.
func TestMigrationIsIdempotentAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	first := openTaskStore(t, path)
	if _, err := first.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')`, t.TempDir()); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	first.Close()

	second := openTaskStore(t, path)
	defer second.Close()
	if !hasColumn(t, second, "tasks", "conversation_id") {
		t.Fatal("a column added by a later migration is missing after a restart")
	}
	var root string
	if err := second.DB.QueryRow("SELECT root FROM projects WHERE id='p'").Scan(&root); err != nil {
		t.Fatalf("the migrated row is gone after a restart: %v", err)
	}
}
