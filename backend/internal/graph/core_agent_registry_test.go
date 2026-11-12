// graph:table-writes-exempt: a test seeds the rows it registers around
package graph

import (
	"path/filepath"
	"testing"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func seedAgentRegistryStore(t *testing.T) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "registry.sqlite"))
	t.Cleanup(store.Close)
	for _, query := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`,
		`INSERT INTO projects(id,root,grants) VALUES('global-workspace','/tmp/global','[]')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES('t-work','p1','work',1,'c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t-direct','p1','direct',2)`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
			VALUES('c-proj','p1','p1','t-work','项目一',1,1000,'project')`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
			VALUES('c-global',NULL,'global-workspace','t-direct','Main',2,900,'global')`,
	} {
		if _, err := store.DB.Exec(query); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	return store
}

func TestRegisterAgentUpsertsStaticIdentityAndKeepsCreationTime(t *testing.T) {
	store := seedAgentRegistryStore(t)
	first := RegisterAgent(store, AgentRegistration{
		Id: "t-work/n1", ParentId: "c-proj", Kind: "node", Role: "implementer",
		Name: "n1", ConversationId: "c-proj", TaskId: "t-work", NodeId: "n1",
		ProjectId: "p1", Workspace: "/tmp/p1", Model: "m1", CreatedAt: 7000,
	})
	if first.Role != "implementer" || first.CreatedAt != 7000 || first.ClosedAt != nil {
		t.Fatalf("registration returned %+v", first)
	}
	second := RegisterAgent(store, AgentRegistration{
		Id: "t-work/n1", ParentId: "c-proj", Kind: "node", Role: "reviewer",
		Name: "renamed", ConversationId: "c-proj", TaskId: "t-work", NodeId: "n1",
		ProjectId: "p1", Workspace: "/tmp/p1", Model: "m2", CreatedAt: 9999,
	})
	if second.Role != "reviewer" || second.Name != "renamed" || second.Model != "m2" {
		t.Fatalf("upsert did not refresh static identity: %+v", second)
	}
	if second.CreatedAt != 7000 {
		t.Fatalf("upsert rewrote the creation time: %+v", second)
	}
	got := AgentById(store, "t-work/n1")
	if got == nil || got.Role != "reviewer" || got.Name != "renamed" || got.Model != "m2" {
		t.Fatalf("AgentById returned %+v", got)
	}
	if missing := AgentById(store, "t-work/n9"); missing != nil {
		t.Fatalf("AgentById invented a row: %+v", missing)
	}
	RegisterAgent(store, AgentRegistration{Id: "child-1", ParentId: "t-work/n1", Kind: "child", Role: "worker", Name: "child"})
	children := AgentChildren(store, "t-work/n1")
	if len(children) != 1 || children[0].Id != "child-1" {
		t.Fatalf("AgentChildren returned %+v", children)
	}
}

func TestRegisterSupervisorAgentHangsProjectOffGlobal(t *testing.T) {
	store := seedAgentRegistryStore(t)
	global := RegisterSupervisorAgent(store, "c-global", ConversationGlobal, "Main", "t-direct", "global-workspace", nil, "m-super")
	if global.Kind != "global" || global.ParentId != "" || global.ConversationId != "c-global" {
		t.Fatalf("global supervisor registered wrong: %+v", global)
	}
	if global.Workspace != "/tmp/global" || global.TaskId != "t-direct" || global.Model != "m-super" {
		t.Fatalf("global supervisor identity wrong: %+v", global)
	}
	projectId := "p1"
	project := RegisterSupervisorAgent(store, "c-proj", ConversationProject, "项目一", "t-work", projectId, &projectId, "m-super")
	if project.Kind != "project" || project.ParentId != "c-global" {
		t.Fatalf("project supervisor must hang off global: %+v", project)
	}
	if project.ProjectId != "p1" || project.Workspace != "/tmp/p1" || project.Name != "项目一" {
		t.Fatalf("project supervisor identity wrong: %+v", project)
	}
}

func TestRegisterNodeAgentDerivesParentRoleAndProject(t *testing.T) {
	store := seedAgentRegistryStore(t)
	node := RegisterNodeAgent(store, "t-work", "n1", "", "")
	if node.Id != "t-work/n1" || node.Kind != "node" || node.Role != "worker" {
		t.Fatalf("RegisterNodeAgent returned %+v", node)
	}
	if node.ParentId != "c-proj" || node.ProjectId != "p1" || node.ConversationId != "c-proj" {
		t.Fatalf("parent/project not derived from the task: %+v", node)
	}
	direct := RegisterNodeAgent(store, "t-direct", "n9", "reviewer", "p2")
	if direct.ParentId != "c-global" {
		t.Fatalf("a task without a supervisor must hang off global, got %+v", direct)
	}
	if direct.Role != "reviewer" || direct.ProjectId != "p2" {
		t.Fatalf("explicit role/project were not kept: %+v", direct)
	}
	again := RegisterNodeAgent(store, "t-work", "n1", "reviewer", "p1")
	if again.Role != "reviewer" || again.CreatedAt != node.CreatedAt {
		t.Fatalf("registration must be idempotent on identity: %+v", again)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("registering a node for an unknown task must fail")
			}
		}()
		RegisterNodeAgent(store, "missing-task", "n1", "", "")
	}()
}

func TestAgentSubtreeWalksTheParentChain(t *testing.T) {
	store := seedAgentRegistryStore(t)
	RegisterAgent(store, AgentRegistration{Id: "g", Kind: "global", Role: "global", Name: "Main"})
	RegisterAgent(store, AgentRegistration{Id: "p1", ParentId: "g", Kind: "project", Role: "project"})
	RegisterAgent(store, AgentRegistration{Id: "p2", ParentId: "g", Kind: "project", Role: "project"})
	RegisterAgent(store, AgentRegistration{Id: "p1/n1", ParentId: "p1", Kind: "node", Role: "worker"})
	RegisterAgent(store, AgentRegistration{Id: "p1/n1/c1", ParentId: "p1/n1", Kind: "child", Role: "worker"})
	RegisterAgent(store, AgentRegistration{Id: "p2/n2", ParentId: "p2", Kind: "node", Role: "worker"})
	all := AgentSubtree(store, "g")
	if len(all) != 6 {
		t.Fatalf("subtree of the global agent has %d agents, want 6: %+v", len(all), all)
	}
	project := AgentSubtree(store, "p1")
	ids := []string{}
	for _, agent := range project {
		ids = append(ids, agent.Id)
	}
	if len(ids) != 3 || ids[0] != "p1" || ids[1] != "p1/n1" || ids[2] != "p1/n1/c1" {
		t.Fatalf("subtree of project p1 is %v", ids)
	}
	if child := AgentSubtree(store, "p1/n1/c1"); len(child) != 1 || child[0].Id != "p1/n1/c1" {
		t.Fatalf("a leaf subtree must contain only the leaf: %+v", child)
	}
	if none := AgentSubtree(store, "missing"); len(none) != 0 {
		t.Fatalf("an unknown root must yield an empty subtree: %+v", none)
	}
}

func TestAgentsTableIsOwnedByTheRegistryFile(t *testing.T) {
	directory, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("package directory: %v", err)
	}
	declared := gate.SchemaTables(directory)
	if !declared["agents"] {
		t.Fatal("the schema files do not declare the agents table")
	}
	if !gate.OwnsIt("core_agent_registry.go", "agents", declared) {
		t.Fatal("core_agent_registry.go is not registered as the owner of agents")
	}
	if gate.OwnsIt("server_fleet.go", "agents", declared) {
		t.Fatal("server_fleet.go must not be allowed to write agents")
	}
	for _, offender := range gate.PackageWrites(directory, nil) {
		if offender.Table == "agents" {
			t.Fatalf("%s:%d writes agents without being its owner", offender.File, offender.Line)
		}
	}
}
