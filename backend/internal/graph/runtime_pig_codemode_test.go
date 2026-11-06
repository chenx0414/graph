// graph:table-writes-exempt: the tests seed the rows the gate reads
package graph

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// A tool that refuses inside a script must report its own refusal. The sandbox
// settles the nested call while the refusal unwinds; settling it a second time
// from the dispatch's recovery used to replace the refusal with a conflict
// about usage evidence, so the caller saw a bookkeeping error instead of the
// reason the tool said no.
func TestCodemodeReportsTheRefusalOfTheToolItself(t *testing.T) {
	gate := scratchCodemodeGate(t)
	refusing := ToolDefinition{
		Name: "refusing", Description: "always refuses", Parameters: map[string]any{"type": "object"},
		Execute: func(string, any) (any, error) { Raise("permission_refused", "the tool said no"); return nil, nil },
	}
	tool := CodemodeTool([]ToolDefinition{refusing}, gate, CodemodeSettings{})
	_, err := tool.Execute("outer", map[string]any{"code": "await tools.refusing({});"})
	if err == nil {
		t.Fatal("the script has to fail when the tool refuses")
	}
	if !strings.Contains(err.Error(), "the tool said no") {
		t.Fatalf("the script has to repeat the tool's own refusal, got %q", err.Error())
	}
}

// A tool that answers normally settles its nested call once.
func TestCodemodeSettlesANestedCallOnce(t *testing.T) {
	gate := scratchCodemodeGate(t)
	child := ToolDefinition{
		Name: "child", Description: "answers", Parameters: map[string]any{"type": "object"},
		Execute: func(string, any) (any, error) { return agentToolsText("child ran"), nil },
	}
	tool := CodemodeTool([]ToolDefinition{child}, gate, CodemodeSettings{})
	result, err := tool.Execute("outer", map[string]any{"code": "const r = await tools.child({}); text('saw ' + r);"})
	if err != nil {
		t.Fatalf("nested call failed: %v", err)
	}
	if !strings.Contains(sprint(result), "saw child ran") {
		t.Fatalf("the script did not see the tool result: %v", result)
	}
}

func sprint(value any) string { return fmt.Sprint(value) }

// scratchCodemodeGate is the task gate of a scratch database, so a nested call
// is admitted and settled the way a real one is.
func scratchCodemodeGate(t *testing.T) SendGate {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	t.Cleanup(store.Close)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p','` + t.TempDir() + `','[]')`,
		`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version) VALUES('t','p','',1,0,'chatting',0,1,1)`,
		`INSERT INTO nodes(task_id,id,spec) VALUES('t','n','{}')`,
		`INSERT INTO instances(id,task_id,node_id) VALUES('i','t','n')`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved) VALUES('op','t','n','i',1,'{}','running',0)`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed %q: %v", statement, err)
		}
	}
	gate := TaskGate(store, TaskGateOperation{Id: "op", TaskId: "t", InstanceId: "i"}, ModelEntry{Id: "m", Provider: "p"}, TaskGateOptions{Optional: true})
	return gate.SendGate
}
