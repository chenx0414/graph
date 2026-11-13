// graph:table-writes-exempt: the test seeds the rows it reads
package graph

import (
	"path/filepath"
	"strconv"
	"testing"
)

func seedNodeTrajectory(t *testing.T) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "node-trajectory.sqlite"))
	t.Cleanup(func() { store.Close() })
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp','[]')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t1','p1','node trajectory',1)`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t1','planner','{"role":"planner"}')`)
	exec(`INSERT INTO nodes(task_id,id,spec) VALUES('t1','worker','{"role":"worker"}')`)
	entry := func(id, node, role, kind, text string, at int64) {
		exec(`INSERT INTO node_entries(id,task_id,node_id,role,kind,text,data,created_at) VALUES(?,?,?,?,?,?,'{}',?)`,
			id, "t1", node, role, kind, text, at)
	}
	entry("u1", "planner", "user", "message", "规划", 1000)
	entry("a1", "planner", "assistant", "message", "好的", 4000)
	entry("t1", "planner", "tool", "call", "bash", 4500)
	entry("r1", "planner", "tool", "result", "完成", 7000)
	entry("u2", "planner", "user", "message", "继续", 20000)
	entry("a2", "planner", "assistant", "message", "收尾", 24000)
	entry("u9", "worker", "user", "message", "另一个节点", 9000)
	exec(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,dispatched_at,settled_at,waiting_ms)
	      VALUES('op1','t1','planner',1,'{}','succeeded',0,0,1000,8000,0)`)
	exec(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,dispatched_at,settled_at,waiting_ms)
	      VALUES('op9','t1','worker',1,'{}','succeeded',0,0,9000,12000,0)`)
	usage := `{"input":100,"output":50,"cacheRead":80,"cacheWrite":20,"contextTokens":400,"firstTokenMs":250,"durationMs":1200}`
	exec(`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
	      VALUES('v1','op1','i1','deepseek-v4',?,?, 'completion',1000,5000)`, usage, `{"total":0.02}`)
	exec(`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
	      VALUES('v9','op9','i1','deepseek-v4',?,?, 'completion',9000,12000)`, usage, `{"total":0.5}`)
	exec(`INSERT INTO tool_calls(instance_id,task_id,node_id,role,tool,ms,is_error,created_at)
	      VALUES('i1','t1','planner','planner','bash',4000,0,4500)`)
	exec(`INSERT INTO tool_calls(instance_id,task_id,node_id,role,tool,ms,is_error,created_at)
	      VALUES('i1','t1','planner','planner','read',100,1,4600)`)
	exec(`INSERT INTO tool_calls(instance_id,task_id,node_id,role,tool,ms,is_error,created_at)
	      VALUES('i1','t1','worker','worker','bash',900,0,9500)`)
	return store
}

func TestNodeTrajectoryGroupsOnlyThatNode(t *testing.T) {
	store := seedNodeTrajectory(t)
	trajectory := BuildNodeTrajectory(store, "t1", "planner")
	if trajectory.TaskId != "t1" || trajectory.ConversationId != "" {
		t.Fatalf("node trajectory identity %+v", trajectory)
	}
	if len(trajectory.Turns) != 2 {
		t.Fatalf("turns %d", len(trajectory.Turns))
	}
	first := trajectory.Turns[0]
	if first.Id != "u1" || first.StartedAt != 1000 || first.EndedAt != 7000 || first.DurationMs != 6000 {
		t.Fatalf("first turn %+v", first)
	}
	if first.Usage.Input != 100 || first.Usage.ContextTokens != 400 || first.Model != "deepseek-v4" {
		t.Fatalf("first turn usage %+v", first.Usage)
	}
	if len(first.ToolCalls) != 2 || first.ToolCalls[0].Name != "bash" || first.ToolCalls[0].Ms != 4000 {
		t.Fatalf("first turn tools %+v", first.ToolCalls)
	}
	if trajectory.Totals.Requests != 1 || trajectory.Totals.ToolCalls != 2 || trajectory.Totals.ToolErrors != 1 {
		t.Fatalf("totals %+v", trajectory.Totals)
	}
	if trajectory.Totals.TotalTokens == 0 || trajectory.Totals.Cost < 0.0199 || trajectory.Totals.Cost > 0.0201 {
		t.Fatalf("totals usage %+v", trajectory.Totals)
	}
	if len(trajectory.Agents) != 1 || trajectory.Agents[0].NodeId != "planner" || trajectory.Agents[0].Role != "planner" {
		t.Fatalf("agents %+v", trajectory.Agents)
	}
	if trajectory.Agents[0].Requests != 1 || trajectory.Agents[0].Cost < 0.0199 || trajectory.Agents[0].Cost > 0.0201 {
		t.Fatalf("agent totals %+v", trajectory.Agents[0])
	}
	worker := BuildNodeTrajectory(store, "t1", "worker")
	if len(worker.Turns) != 1 || worker.Turns[0].Id != "u9" {
		t.Fatalf("worker turns %+v", worker.Turns)
	}
	if worker.Totals.ToolsByName[0].Name != "bash" || worker.Totals.ToolCalls != 1 {
		t.Fatalf("worker tools %+v", worker.Totals.ToolsByName)
	}
	empty := BuildNodeTrajectory(store, "t1", "missing")
	if len(empty.Turns) != 0 || empty.Totals.Requests != 0 {
		t.Fatalf("an unknown node returns an empty trajectory, %+v", empty)
	}
	if empty.Turns == nil {
		t.Fatal("the empty trajectory keeps an empty turns array")
	}
}

func TestConversationTrajectoryIgnoresNodeEntries(t *testing.T) {
	store := seedNodeTrajectory(t)
	if _, err := store.DB.Exec(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
		VALUES('c1',NULL,'p1','t1','测试',1,0)`); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO messages(id,conversation_id,role,kind,text,state,turn,created_at,updated_at)
		VALUES('m1','c1','user','chat','会话里的问题','done',1,` + strconv.Itoa(1000) + `,` + strconv.Itoa(1000) + `)`); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	conversation := BuildConversationTrajectory(store, "c1")
	if len(conversation.Turns) != 1 || conversation.Turns[0].Id != "m1" {
		t.Fatalf("conversation turns %+v", conversation.Turns)
	}
	node := BuildNodeTrajectory(store, "t1", "planner")
	for _, turn := range node.Turns {
		if turn.Id == "m1" {
			t.Fatal("a node trajectory must not pick up conversation messages")
		}
	}
}

func TestNodeTrajectoryCountsKernelProviderCalls(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "node-kernel-trajectory.sqlite"))
	t.Cleanup(func() { store.Close() })
	NewKernelStore(store)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp','[]')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t1','p1','kernel node',1)`)
	exec(`INSERT INTO node_entries(id,task_id,node_id,role,kind,text,data,created_at)
	      VALUES('u1','t1','planner','user','message','规划','{}',1000)`)
	usage := `{"input":100,"output":50,"cacheRead":80,"cacheWrite":20,"contextTokens":400,"firstTokenMs":250,"durationMs":1200}`
	exec(`INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,usage,created_at,settled_at,model,purpose,cost)
	      VALUES('k1','t1','planner','exec-1',0,'settled',?,1000,3000,'deepseek-v4','completion','{"amount":0.02}')`, usage)
	exec(`INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,usage,created_at,settled_at,model,purpose,cost)
	      VALUES('k2','t1','planner','exec-1',0,'settled',?,4000,6000,'deepseek-v4','completion','{"amount":0.03}')`, usage)
	trajectory := BuildNodeTrajectory(store, "t1", "planner")
	if trajectory.Totals.Requests != 2 {
		t.Fatalf("kernel calls must be counted as requests, totals %+v", trajectory.Totals)
	}
	if trajectory.Totals.Input != 200 || trajectory.Totals.Output != 100 {
		t.Fatalf("kernel call usage must land in the totals, totals %+v", trajectory.Totals)
	}
	if trajectory.Totals.Cost < 0.0499 || trajectory.Totals.Cost > 0.0501 {
		t.Fatalf("kernel call cost must land in the totals, totals %+v", trajectory.Totals)
	}
	if len(trajectory.Turns) != 1 || len(trajectory.Turns[0].Invocations) != 2 {
		t.Fatalf("kernel calls must attach to the turn, turns %+v", trajectory.Turns)
	}
	if trajectory.Agents[0].Requests != 2 || trajectory.Agents[0].Model != "deepseek-v4" {
		t.Fatalf("the node agent carries kernel usage, agents %+v", trajectory.Agents)
	}
}
