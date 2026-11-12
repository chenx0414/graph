// graph:table-writes-exempt: the test seeds the rows it reads
package graph

import (
	"path/filepath"
	"strconv"
	"testing"
)

func TestConversationTrajectoryGroupsTurnsAndMetrics(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "trajectory.sqlite"))
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp','[]')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t1','p1','hi',1)`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t1','n1','{}')`)
	exec(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
	      VALUES('c1',NULL,'p1','t1','测试',1,0)`)
	message := func(id, role, kind, text, op string, turn int, at int64) {
		exec(`INSERT INTO messages(id,conversation_id,role,kind,text,state,operation_id,turn,created_at,updated_at)
		      VALUES(?,?,?,?,?,'done',?,?,?,?)`, id, "c1", role, kind, text, op, turn, at, at)
	}
	message("u1", "user", "chat", "开始", "op1", 1, 1000)
	message("a1", "assistant", "chat", "好的", "op1", 1, 3000)
	message("t1", "tool", "call", "bash: ls", "op1", 1, 4000)
	message("r1", "tool", "result", "完成", "op1", 1, 8000)
	message("u2", "user", "chat", "继续", "op2", 2, 20000)
	message("a2", "assistant", "chat", "完成", "op2", 2, 22000)
	operation := func(id string, attempt int, at, end int64) {
		exec(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,dispatched_at,settled_at,waiting_ms)
		      VALUES(?,?,?,1,'{"attempt":`+strconv.Itoa(attempt)+`}','succeeded',0,0,?,?,0)`, id, "t1", "n1", at, end)
	}
	operation("op1", 1, 1000, 9000)
	operation("op2", 2, 20000, 23000)
	invocation := func(id, op string, input, output, cacheRead, cacheWrite int64, cost string, at, end int64) {
		usage := `{"input":` + strconv.FormatInt(input, 10) + `,"output":` + strconv.FormatInt(output, 10) +
			`,"cacheRead":` + strconv.FormatInt(cacheRead, 10) + `,"cacheWrite":` + strconv.FormatInt(cacheWrite, 10) +
			`,"contextTokens":400,"firstTokenMs":250,"durationMs":1200}`
		exec(`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
		      VALUES(?,?,?, ?,?,?,'completion',?,?)`, id, op, "i1", "deepseek-v4", usage, cost, at, end)
	}
	invocation("v1", "op1", 100, 50, 80, 20, `{"total":0.02}`, 1000, 5000)
	invocation("v2", "op2", 40, 10, 30, 10, `{"total":0.01}`, 20000, 22000)
	exec(`INSERT INTO tool_calls(instance_id,task_id,node_id,role,tool,ms,is_error,created_at)
	      VALUES('i1','t1','n1','worker','bash',4000,0,4000)`)
	exec(`UPDATE operations SET system_prompt='you are an agent',tool_declarations='[{"name":"bash"}]' WHERE id='op2'`)

	trajectory := BuildConversationTrajectory(store, "c1")
	if len(trajectory.Turns) != 2 {
		t.Fatalf("turns %d", len(trajectory.Turns))
	}
	first := trajectory.Turns[0]
	if first.Id != "u1" || first.StartedAt != 1000 || first.DurationMs != 7000 {
		t.Fatalf("first turn %+v", first)
	}
	if first.Model != "deepseek-v4" || first.Usage.Input != 100 || first.Usage.Output != 50 ||
		first.Usage.CacheRead != 80 || first.Usage.CacheWrite != 20 || first.Usage.ContextTokens != 400 {
		t.Fatalf("first turn usage %+v", first.Usage)
	}
	if first.Cost < 0.0199 || first.Cost > 0.0201 {
		t.Fatalf("first turn cost %v", first.Cost)
	}
	if len(first.ToolCalls) != 1 || first.ToolCalls[0].Name != "bash" || first.ToolCalls[0].Ms != 4000 {
		t.Fatalf("first turn tools %+v", first.ToolCalls)
	}
	if len(first.Invocations) != 1 || first.Invocations[0].Usage.FirstTokenMs != 250 {
		t.Fatalf("first turn invocations %+v", first.Invocations)
	}
	totals := trajectory.Totals
	if totals.Turns != 2 || totals.ToolCalls != 1 || totals.Input != 140 || totals.Output != 60 ||
		totals.CacheRead != 110 || totals.CacheWrite != 30 || totals.Cost < 0.0299 || totals.Cost > 0.0301 {
		t.Fatalf("totals %+v", totals)
	}
	if totals.DurationMs != 7000+2000 {
		t.Fatalf("wall time %+v", totals)
	}
	if totals.Requests != 2 || totals.UserMessages != 2 || totals.ModelReplies != 2 || totals.ToolMessages != 2 {
		t.Fatalf("counts %+v", totals)
	}
	if len(totals.ToolsByName) != 1 || totals.ToolsByName[0].Name != "bash" || totals.ToolsByName[0].Count != 1 || totals.ToolsByName[0].Ms != 4000 {
		t.Fatalf("tools by name %+v", totals.ToolsByName)
	}
	if totals.Timing.ToolMs != 4000 || totals.Timing.TtftMs != 500 || totals.Timing.WallMs != 9000 {
		t.Fatalf("timing %+v", totals.Timing)
	}
	if totals.Context.LastTokens != 400 || totals.Context.PeakTokens != 400 {
		t.Fatalf("context %+v", totals.Context)
	}
	if len(trajectory.Requests) != 2 || trajectory.Requests[0].ContextTokens != 400 || trajectory.Requests[1].Id != "v2" {
		t.Fatalf("requests %+v", trajectory.Requests)
	}
	if len(totals.Commands) != 1 || totals.Commands[0].Name != "ls" || totals.Commands[0].Count != 1 {
		t.Fatalf("commands %+v", totals.Commands)
	}
	composition := trajectory.Composition
	if composition.SystemPrompt != 4 || composition.ToolDefinitions != 5 {
		t.Fatalf("composition prompt %+v", composition)
	}
	if composition.UserMessages != 4 || composition.AssistantReply != 4 || composition.ToolCalls != 0 {
		t.Fatalf("composition messages %+v", composition)
	}

	SaveConversationTrajectory(store, "c1")
	row := kernelRow(store.DB, "SELECT conversation_id,task_id,payload FROM trajectories WHERE conversation_id='c1'")
	if row == nil || kernelString(row["task_id"]) != "t1" || kernelString(row["payload"]) == "" {
		t.Fatalf("stored trajectory %+v", row)
	}
}
