// graph:table-writes-exempt: the test seeds the rows the gate reads
package graph

import (
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// A node tool that refuses reports its own reason. Its nested settlement must
// not run while the refusal unwinds: the dispatch's recovery settles the same
// call with no evidence, and the conflict that follows replaces the refusal
// with a bookkeeping error.
func TestNodeToolRefusalKeepsItsOwnReason(t *testing.T) {
	gate := scratchTaskGate(t)
	request := AgentSessionRequest{Tools: []ToolDefinition{{
		Name: "refusing", Description: "always refuses", Parameters: map[string]any{"type": "object"},
		Execute: func(string, any) (any, error) { Raise("permission_refused", "the tool said no"); return nil, nil },
	}}}
	specs := pigNodeToolSpecs(request, gate, nil)
	if len(specs) != 1 {
		t.Fatalf("expected one tool, got %d", len(specs))
	}
	_, err := specs[0].Result(t.Context(), map[string]any{})
	if err == nil {
		t.Fatal("the refusal has to reach the model as an error")
	}
	if !strings.Contains(err.Error(), "the tool said no") {
		t.Fatalf("the model has to read the tool's own refusal, got %q", err.Error())
	}
}

// scratchTaskGate is the task gate of a scratch database, so a tool call is
// admitted and settled the way a real one is.
func scratchTaskGate(t *testing.T) SendGate {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	store := openTaskStore(t, path)
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
