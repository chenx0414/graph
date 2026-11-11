package gate

import "testing"

func TestWritesInFindsTheOwnedTablesAStatementNames(t *testing.T) {
	source := `package graph

const a = "UPDATE tasks SET phase = 1"
const b = "INSERT INTO questions (id) VALUES (1)"
const c = "INSERT OR REPLACE INTO work_graphs (id) VALUES (1)"
const d = "DELETE FROM events"
const e = "REPLACE INTO presets (id) VALUES (1)"
const f = "UPDATE kernel_sessions SET x = 1"
const g = "UPDATE something_else SET x = 1"
// UPDATE tasks SET phase = 2
`
	found := WritesIn(source)
	want := []string{"tasks", "questions", "work_graphs", "events", "presets", "kernel_sessions"}
	if len(found) != len(want) {
		t.Fatalf("found %+v, want %v", found, want)
	}
	for index, write := range found {
		if write.Table != want[index] {
			t.Fatalf("write %d names %s, want %s", index, write.Table, want[index])
		}
	}
	if found[0].Line != 3 {
		t.Fatalf("the line number must point at the statement, got %d", found[0].Line)
	}
}

func TestOwnsItFollowsTheNamedOwnerThenThePrefix(t *testing.T) {
	declared := map[string]bool{"tasks": true, "brand_new": true}
	for _, test := range []struct {
		name   string
		table  string
		owner  bool
		reason string
	}{
		{"core_task_lifecycle.go", "tasks", true, "the named owner writes it"},
		{"core_task_nodes.go", "tasks", false, "another file must not"},
		{"core_kernel_state.go", "kernel_sessions", true, "kernel tables belong to core_kernel files"},
		{"core_task_nodes.go", "kernel_sessions", false, "that file is not a kernel store"},
		{"anything.go", "brand_new", false, "a declared table with no owner needs one first"},
		{"anything.go", "undeclared_thing", true, "a table the schema never declares is not ours"},
	} {
		if got := OwnsIt(test.name, test.table, declared); got != test.owner {
			t.Fatalf("%s: %s -> %v (%s)", test.name, test.table, got, test.reason)
		}
	}
}

func TestPackageWritesReportsOnlyUnownedStatements(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "core_store_schema.go", "const schema = `CREATE TABLE IF NOT EXISTS tasks (id TEXT); CREATE TABLE widgets (id TEXT);`")
	writeFile(t, root, "core_task_lifecycle.go", "package graph\n\nconst q = \"UPDATE tasks SET phase = 1\"\n")
	writeFile(t, root, "intruder.go", "package graph\n\nconst q = \"UPDATE tasks SET phase = 2\"\n")
	writeFile(t, root, "migration.go", "package graph\n\n// graph:table-writes-exempt: migration\nconst q = \"DELETE FROM tasks\"\n")
	writeFile(t, root, "widgets.go", "package graph\n\nconst q = \"INSERT INTO widgets (id) VALUES (1)\"\n")
	declared := SchemaTables(root)
	if !declared["tasks"] || !declared["widgets"] {
		t.Fatalf("the schema must declare both tables, got %+v", declared)
	}
	offenders := PackageWrites(root, nil)
	if len(offenders) != 1 || offenders[0].Table != "tasks" {
		t.Fatalf("only a second writer for an owned table is reported today, got %+v", offenders)
	}
	if found := WritesIn("const q = \"INSERT INTO widgets (id) VALUES (1)\""); len(found) != 0 {
		t.Fatalf("a declared table with no registered owner is still out of scope, got %+v", found)
	}
}
