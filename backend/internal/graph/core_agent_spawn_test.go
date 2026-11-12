// graph:table-writes-exempt: the test seeds the rows the spawn transaction reads
package graph

import (
	"path/filepath"
	"testing"
)

func spawnRuntime(t *testing.T, limits *TaskRuntimeLimits) *TaskRuntime {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "spawn.sqlite"))
	t.Cleanup(store.Close)
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`); err != nil {
		t.Fatalf("project: %v", err)
	}
	model := "deepseek-v4"
	definition := "main@1"
	return &TaskRuntime{
		store: store, kernel: NewKernelStore(store), stateDir: t.TempDir(), limits: limits,
		master: &TaskRuntimeMaster{Model: func() string { return model }, DefinitionVersion: func() string { return definition }},
	}
}

func TestSpawnAgentCreatesAPersistentChildIdentity(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	receipt := runtime.SpawnAgent(AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: t.TempDir()},
		AgentSpawnInput{Objective: "研究 MyGo 的 Draw API", Name: "研究子 Agent"}).(map[string]any)
	agentID := kernelString(receipt["agentId"])
	if agentID == "" || kernelString(receipt["conversationId"]) != agentID {
		t.Fatalf("receipt = %+v", receipt)
	}
	agent := AgentById(runtime.store, agentID)
	if agent == nil || agent.Kind != "child" || agent.ParentId != "global" || agent.ProjectId != "p1" || agent.Name != "研究子 Agent" {
		t.Fatalf("agent = %+v", agent)
	}
	conversation := ConversationRowOf(runtime.store, agentID)
	if conversation.Id == "" || conversation.Role != ConversationChild || conversation.AnchorTaskId != kernelString(receipt["taskId"]) {
		t.Fatalf("conversation = %+v", conversation)
	}
	task := runtime.store.Task(conversation.AnchorTaskId)
	if task.ID == "" || task.Phase != "chatting" {
		t.Fatalf("task = %+v", task)
	}
	if kernelRow(runtime.store.Db, "SELECT 1 FROM nodes WHERE task_id=? AND id='master'", task.ID) == nil {
		t.Fatal("the child has no master node")
	}
	messages := kernelRows(runtime.store.Db, "SELECT id,state FROM messages WHERE conversation_id=?", agentID)
	if len(messages) != 1 || kernelString(messages[0]["state"]) != "pending" {
		t.Fatalf("messages = %+v", messages)
	}
	if kernelRow(runtime.store.Db, "SELECT 1 FROM projects WHERE id=?", "child:"+agentID) == nil {
		t.Fatal("the isolated child workspace has no project row")
	}
	if kernelRow(runtime.store.Db, "SELECT 1 FROM events WHERE task_id=? AND type='agent.spawned'", task.ID) == nil {
		t.Fatal("the spawn event is missing")
	}
}

func TestSpawnAgentEnforcesDepthChildrenAndTotal(t *testing.T) {
	runtime := spawnRuntime(t, &TaskRuntimeLimits{MaxAgents: 100, SpawnDepth: 1, ChildrenPerAgent: 1})
	if _, err := runtime.store.DB.Exec(`INSERT INTO agents(id,parent_id,kind,role,name,created_at,metadata) VALUES('g1/node','global','node','worker','node',0,'{}')`); err != nil {
		t.Fatalf("seed node agent: %v", err)
	}
	first := runtime.SpawnAgent(AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: t.TempDir()},
		AgentSpawnInput{Objective: "first"}).(map[string]any)
	childID := kernelString(first["agentId"])
	assertSpawnRefused(t, "agent_limit", func() {
		runtime.SpawnAgent(AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: t.TempDir()},
			AgentSpawnInput{Objective: "second"})
	})
	assertSpawnRefused(t, "agent_limit", func() {
		runtime.SpawnAgent(AgentSpawnParent{AgentId: childID, ProjectId: "p1", Workspace: t.TempDir()},
			AgentSpawnInput{Objective: "grandchild"})
	})
	tiny := runtime.spawnDepthForTest()
	if tiny != 1 {
		t.Fatalf("depth limit = %d", tiny)
	}
}

func assertSpawnRefused(t *testing.T, code string, call func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("the spawn must be refused")
		}
		failure, ok := recovered.(*RuntimeError)
		if !ok || failure.Code != code {
			t.Fatalf("refusal = %v, want code %q", recovered, code)
		}
	}()
	call()
}

func (runtime *TaskRuntime) spawnDepthForTest() int {
	_, depth, _ := runtime.spawnLimitValues()
	return depth
}

func TestSpawnAgentInheritsTheParentModel(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	if _, err := runtime.store.DB.Exec(`INSERT INTO agents(id,kind,role,name,model,created_at,metadata) VALUES('global','global','global','Main','parent-model',0,'{}')`); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	receipt := runtime.SpawnAgent(AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: t.TempDir()},
		AgentSpawnInput{Objective: "inherit"}).(map[string]any)
	agent := AgentById(runtime.store, kernelString(receipt["agentId"]))
	if agent == nil || agent.Model != "parent-model" {
		t.Fatalf("child model = %+v", agent)
	}
}
