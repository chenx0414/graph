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

// The agents table is the single identity source for the fleet projection, so
// the upgrade has to register what already exists: supervisor conversations,
// the graph nodes written by the legacy lane, and the nodes of the kernel lane.
func TestMigrationV60RegistersAgentsFromConversationsNodesAndKernelNodes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	store := openTaskStore(t, path)
	_ = NewKernelStore(store)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('global-workspace','/tmp/global','[]')`)
	exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t-global','global-workspace','Main',1)`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t-proj','p1','Project',2)`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES('t-work','p1','Work',3,'c-proj')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t-direct','p1','Direct',4)`)
	exec(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c-global',NULL,'global-workspace','t-global','Main',1,1000,'global')`)
	exec(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c-proj','p1','p1','t-proj','项目一',2,1100,'project')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t-global','master','{"role":"master"}')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t-proj','master','{"role":"master"}')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t-work','n1','{"role":"implementer","model":"m1"}')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t-work','n2','{}')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t-direct','n3','{}')`)
	exec(`INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status)
		VALUES('t-work',1,'n4','i4','agent','{"model":"m-kernel"}','idle')`)
	exec(`DELETE FROM agents`)
	exec(`PRAGMA user_version=59`)
	store.Close()

	store = openTaskStore(t, path)
	agents := func() map[string]map[string]any {
		t.Helper()
		out := map[string]map[string]any{}
		for _, row := range kernelRows(store.DB, "SELECT * FROM agents") {
			out[kernelString(row["id"])] = row
		}
		return out
	}
	rows := agents()
	if len(rows) != 6 {
		t.Fatalf("the upgrade registered %d agents, want 6: %v", len(rows), rows)
	}
	agent := func(id string) map[string]any {
		t.Helper()
		row := rows[id]
		if row == nil {
			t.Fatalf("the upgrade did not register %s", id)
		}
		return row
	}
	global := agent("c-global")
	if kernelString(global["kind"]) != "global" || kernelString(global["name"]) != "Main" || global["parent_id"] != nil {
		t.Fatalf("global supervisor registered wrong: %+v", global)
	}
	if kernelString(global["conversation_id"]) != "c-global" || kernelString(global["task_id"]) != "t-global" {
		t.Fatalf("global supervisor identity wrong: %+v", global)
	}
	if kernelString(global["workspace"]) != "/tmp/global" || kernelInt(global["created_at"]) != 1000 {
		t.Fatalf("global supervisor workspace/time wrong: %+v", global)
	}
	project := agent("c-proj")
	if kernelString(project["kind"]) != "project" || kernelString(project["parent_id"]) != "c-global" {
		t.Fatalf("project supervisor must hang off the global agent: %+v", project)
	}
	if kernelString(project["project_id"]) != "p1" || kernelString(project["name"]) != "项目一" {
		t.Fatalf("project supervisor identity wrong: %+v", project)
	}
	n1 := agent("t-work/n1")
	if kernelString(n1["kind"]) != "node" || kernelString(n1["role"]) != "implementer" {
		t.Fatalf("legacy node agent role wrong: %+v", n1)
	}
	if kernelString(n1["parent_id"]) != "c-proj" || kernelString(n1["node_id"]) != "n1" || kernelString(n1["task_id"]) != "t-work" {
		t.Fatalf("legacy node agent parent/identity wrong: %+v", n1)
	}
	if kernelString(n1["model"]) != "m1" || kernelString(n1["project_id"]) != "p1" {
		t.Fatalf("legacy node agent model/project wrong: %+v", n1)
	}
	if role := kernelString(agent("t-work/n2")["role"]); role != "worker" {
		t.Fatalf("a node without a spec role must register as worker, got %q", role)
	}
	if parent := kernelString(agent("t-direct/n3")["parent_id"]); parent != "c-global" {
		t.Fatalf("a node whose task has no supervisor must hang off global, got %q", parent)
	}
	n4 := agent("t-work/n4")
	if kernelString(n4["kind"]) != "node" || kernelString(n4["parent_id"]) != "c-proj" {
		t.Fatalf("kernel node agent parent wrong: %+v", n4)
	}
	if kernelString(n4["model"]) != "m-kernel" || kernelString(n4["role"]) != "worker" {
		t.Fatalf("kernel node agent model/role wrong: %+v", n4)
	}
	for id := range rows {
		if id == "t-global/master" || id == "t-proj/master" {
			t.Fatalf("the supervisor master node must not be registered as a node agent: %s", id)
		}
	}
	var version int
	if err := store.DB.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("read version: %v", err)
	}
	if version != 60 || SCHEMA_VERSION != 60 {
		t.Fatalf("version is %d / SCHEMA_VERSION %d, want 60", version, SCHEMA_VERSION)
	}
	if _, err := store.DB.Exec(`INSERT INTO agents(id,kind,parent_id) VALUES('child-1','child','c-global')`); err != nil {
		t.Fatalf("the schema must accept a child agent: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO agents(id,kind) VALUES('bad','robot')`); err == nil {
		t.Fatal("the schema must reject an unknown agent kind")
	}
	before := agents()
	store.Close()

	again := openTaskStore(t, path)
	defer again.Close()
	after := map[string]map[string]any{}
	for _, row := range kernelRows(again.DB, "SELECT * FROM agents") {
		after[kernelString(row["id"])] = row
	}
	if len(after) != len(before) {
		t.Fatalf("reopening re-ran the backfill: %d rows became %d", len(before), len(after))
	}
	for id := range before {
		if kernelString(after[id]["parent_id"]) != kernelString(before[id]["parent_id"]) {
			t.Fatalf("reopening rewrote agent %s: %+v", id, after[id])
		}
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
