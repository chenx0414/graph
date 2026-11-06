// graph:table-writes-exempt: the test seeds the rows the gate reads
package graph

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// A settle that disagrees with the evidence already recorded must name the
// invocation and both values. Without them the operator sees
// "Conflicting usage evidence" on a tool call and has no way to tell which
// call the second settle belonged to.
func TestConflictingSettleNamesTheInvocationAndBothValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	defer store.Close()
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')`, t.TempDir()); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version) VALUES('t','p','',1,0,'chatting',0,1,1)`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t','n','{}')`); err != nil {
		t.Fatalf("seed node: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO instances(id,task_id,node_id) VALUES('i','t','n')`); err != nil {
		t.Fatalf("seed instance: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved) VALUES('op','t','n','i',1,'{}','running',0)`); err != nil {
		t.Fatalf("seed operation: %v", err)
	}
	gate := TaskGate(store, TaskGateOperation{Id: "op", TaskId: "t", InstanceId: "i"}, ModelEntry{Id: "m", Provider: "p"}, TaskGateOptions{Optional: true})
	gate.Dispatch("call-1", 0, func() any { return nil })
	gate.Settle("call-1", &TokenUsage{Input: 10, Output: 1})

	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("a second, different settle must be refused")
		}
		failure, _ := recovered.(*RuntimeError)
		message := ""
		if failure != nil {
			message = failure.Message
		}
		for _, want := range []string{"call-1", `"input":10`, `"input":20`} {
			if !strings.Contains(message, want) {
				t.Fatalf("the refusal has to name %s, got %q", want, message)
			}
		}
	}()
	gate.Settle("call-1", &TokenUsage{Input: 20, Output: 1})
}
