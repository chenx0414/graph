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

// A database written by an older build is upgraded in place: every later
// migration runs, the schema ends at the current version, and the rows that
// were already there survive.
func TestMigrationUpgradesADatabaseFromTheFirstSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy: %v", err)
	}
	if _, err := legacy.Exec(schemaV1); err != nil {
		t.Fatalf("apply the first schema: %v", err)
	}
	if _, err := legacy.Exec(`INSERT INTO projects(id,root,grants) VALUES('p','/tmp/legacy','[]')`); err != nil {
		t.Fatalf("seed legacy project: %v", err)
	}
	if _, err := legacy.Exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('old','p','previous request',1)`); err != nil {
		t.Fatalf("seed legacy task: %v", err)
	}
	var legacyVersion int
	if err := legacy.QueryRow("PRAGMA user_version").Scan(&legacyVersion); err != nil {
		t.Fatalf("read legacy version: %v", err)
	}
	if legacyVersion != 1 {
		t.Fatalf("the fixture has to be a version-1 database, got %d", legacyVersion)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy: %v", err)
	}

	store := openTaskStore(t, path)
	if !hasColumn(t, store, "tasks", "graph_version") {
		t.Fatal("the upgrade did not add tasks.graph_version")
	}
	// A table introduced by a much later migration has to be there too: the
	// upgrade walks the whole chain, not just the next step.
	var drafts int
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='work_drafts'").Scan(&drafts); err != nil {
		t.Fatalf("read schema: %v", err)
	}
	if drafts != 1 {
		t.Fatal("the upgrade stopped before the work_drafts table was created")
	}
	var version int
	if err := store.DB.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("read upgraded version: %v", err)
	}
	if version != SCHEMA_VERSION {
		t.Fatalf("the upgrade stopped at version %d, want %d", version, SCHEMA_VERSION)
	}
	var request string
	if err := store.DB.QueryRow("SELECT request FROM tasks WHERE id='old'").Scan(&request); err != nil {
		t.Fatalf("the row written by the older build is gone: %v", err)
	}
	if request != "previous request" {
		t.Fatalf("the upgrade rewrote the row: %q", request)
	}
	store.Close()

	// And the upgraded database opens again without re-running the work.
	again := openTaskStore(t, path)
	defer again.Close()
	var stillThere string
	if err := again.DB.QueryRow("SELECT request FROM tasks WHERE id='old'").Scan(&stillThere); err != nil {
		t.Fatalf("the upgraded row is gone after a restart: %v", err)
	}
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
