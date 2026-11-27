// graph:table-writes-exempt: the preflight test builds its own schema to stand in for the daemon's
package appinstall

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// seedState writes the operations table the daemon keeps, so a preflight can read
// the same durable rows the reload gate reads.
func seedState(t *testing.T, dir string, rows [][3]any) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT NOT NULL, grants TEXT DEFAULT '[]')`,
		`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request TEXT NOT NULL,
            requirement_version INTEGER NOT NULL DEFAULT 1, latest_proposal INTEGER NOT NULL DEFAULT 0,
            phase TEXT NOT NULL DEFAULT 'discussing', paused INTEGER NOT NULL DEFAULT 0,
            created_seq INTEGER NOT NULL DEFAULT 0, graph_version INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS nodes(task_id TEXT NOT NULL, id TEXT NOT NULL, spec TEXT NOT NULL,
            PRIMARY KEY(task_id, id))`,
		`CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
            generation INTEGER NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, reserved INTEGER NOT NULL DEFAULT 1,
            worker_active INTEGER NOT NULL DEFAULT 0, waiting_slot INTEGER NOT NULL DEFAULT 0, settled_at INTEGER)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO projects(id, root) VALUES('p1','/tmp')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO tasks(id, project_id, request) VALUES('t1','p1','e2e')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO nodes(task_id, id, spec) VALUES('t1','n1','{}')`); err != nil {
		t.Fatal(err)
	}
	for index, row := range rows {
		if _, err := db.Exec(
			`INSERT INTO operations(id, task_id, node_id, generation, spec, state, settled_at) VALUES(?,'t1','n1',1,'{}',?,?)`,
			"op"+string(rune('a'+index)), row[0], row[1],
		); err != nil {
			t.Fatalf("seed operation: %v", err)
		}
	}
	return path
}

// An install replaces the bundle that launchd runs, so a watcher starts a new
// daemon — the probe measured 43854 to 44304 with the operation cut to unknown.
// The installer must refuse before it copies anything: a deferred install is a
// command the caller retries, not a turn that is lost.
func TestInstallDefersWhileAnOperationHasNotSettled(t *testing.T) {
	stateDir := t.TempDir()
	seedState(t, stateDir, [][3]any{{"dispatched", nil}})

	err := preflightInstall(InstallOptions{StateDir: stateDir})
	if err == nil {
		t.Fatal("install must defer while an operation is in flight")
	}
	var exit *ExitError
	if !asExitError(err, &exit) || exit.Code != ExitDeferred {
		t.Fatalf("the refusal must be a deferred exit, got %v", err)
	}
}

// A rebuild is installable once the work has settled, or a rebuild could never
// take effect after a long turn.
func TestInstallProceedsWhenNothingIsInFlight(t *testing.T) {
	stateDir := t.TempDir()
	seedState(t, stateDir, [][3]any{{"succeeded", 123}})

	if err := preflightInstall(InstallOptions{StateDir: stateDir}); err != nil {
		t.Fatalf("an idle daemon must accept an install: %v", err)
	}
}

// Every unsettled state is work in flight, so no window between them reads idle.
func TestPreflightCoversEveryUnsettledState(t *testing.T) {
	for _, state := range []string{"intent", "prepared", "dispatched", "running", "failed"} {
		stateDir := t.TempDir()
		seedState(t, stateDir, [][3]any{{state, nil}})
		if err := preflightInstall(InstallOptions{StateDir: stateDir}); err == nil {
			t.Errorf("state %q must defer the install", state)
		}
	}
}

// A machine with no daemon state has no work in flight: refusing there would make
// the first install on a fresh machine impossible.
func TestPreflightAllowsAnInstallWithNoState(t *testing.T) {
	if err := preflightInstall(InstallOptions{StateDir: t.TempDir()}); err != nil {
		t.Fatalf("a state directory with no database must install: %v", err)
	}
}
