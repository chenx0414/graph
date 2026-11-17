// graph:table-writes-exempt: a test seeds the rows the projection reads
package graph

import (
	"testing"
)

func TestListProjectsHidesArchivedProjects(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	runtime.git = NewGitIntegration(runtime.store, t.TempDir())
	runtime.projects = []ProjectConfig{{Id: "p1", Root: "/tmp/p1"}, {Id: "p2", Root: "/tmp/p2"}}
	kernelExec(runtime.store.DB, "INSERT INTO projects(id,root,grants) VALUES('p2','/tmp/p2','[]')")
	runtime.store.ArchiveProject("p1", 1)
	projects := (&TaskRuntimeSupervisor{runtime: runtime}).ListProjects()
	if len(projects) != 1 || kernelString(projects[0]["id"]) != "p2" {
		t.Fatalf("list_projects hides archived projects, got %+v", projects)
	}
}

func TestBindingAnArchivedProjectIsRejected(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	runtime.projects = []ProjectConfig{{Id: "p1", Root: "/tmp/p1"}}
	kernelExec(runtime.store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t1','p1','chat',1,'chatting')")
	kernelExec(runtime.store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c1','p1','t1','chat',1,1,'legacy')`)
	runtime.store.ArchiveProject("p1", 1)
	assertSpawnRefused(t, "project_archived", func() {
		runtime.Conversations().Bind("c1", "p1", "bind-archived")
	})
}

func TestFleetHidesArchivedProjectAgentsAndWork(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, "UPDATE projects SET archived_at=1 WHERE id='p1'")
	fleetSnapshotsForget(fixture.store)
	view := fixture.fleet(t, "")
	for _, agent := range view.Agents {
		if agent.ProjectId == "p1" {
			t.Fatalf("the archived project agent is projected: %+v", agent)
		}
	}
	for _, task := range view.Tasks {
		if task.ProjectId == "p1" {
			t.Fatalf("the archived project task is projected: %+v", task)
		}
	}
	for _, event := range view.Events {
		if event.TaskId == "t-work" || event.TaskId == "t-proj" || event.TaskId == "t-old" {
			t.Fatalf("the archived project event is projected: %+v", event)
		}
	}
	for _, artifact := range view.Artifacts {
		if artifact.TaskId == "t-work" || artifact.TaskId == "t-old" {
			t.Fatalf("the archived project artifact is projected: %+v", artifact)
		}
	}
	fixture.exec(t, "UPDATE projects SET archived_at=NULL WHERE id='p1'")
	fleetSnapshotsForget(fixture.store)
	restored := fixture.fleet(t, "")
	found := false
	for _, agent := range restored.Agents {
		if agent.ProjectId == "p1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("restoring the project restores its agents: %+v", restored.Agents)
	}
}

func TestOpeningAnArchivedProjectThreadIsRejected(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	runtime.projects = []ProjectConfig{{Id: "p1", Root: "/tmp/p1"}}
	runtime.store.ArchiveProject("p1", 1)
	assertSpawnRefused(t, "project_archived", func() {
		runtime.OpenProjectThread("p1", "open-archived")
	})
}

func TestArchivingUnassignedChildSessions(t *testing.T) {
	runtime := spawnRuntime(t, nil)
	workspace := t.TempDir()
	runtime.projects = []ProjectConfig{{Id: "p1", Root: workspace}}
	RegisterAgent(runtime.store, AgentRegistration{Id: "global", Kind: "global", Workspace: workspace})
	RegisterAgent(runtime.store, AgentRegistration{Id: "project-p1", Kind: "project", ProjectId: "p1", ConversationId: "p1", Workspace: workspace})
	orphan := runtime.SpawnAgent(AgentSpawnParent{AgentId: "global", Workspace: workspace},
		AgentSpawnInput{Objective: "orphan"}).(map[string]any)
	assigned := runtime.SpawnAgent(AgentSpawnParent{AgentId: "project-p1", ProjectId: "p1", Workspace: workspace},
		AgentSpawnInput{Objective: "assigned"}).(map[string]any)
	result := runtime.ArchiveUnassignedChildSessions("archive-unassigned")
	if result.Archived != 1 {
		t.Fatalf("one unassigned child session is archived, got %+v", result)
	}
	orphanConversation := ConversationRowOf(runtime.store, kernelString(orphan["conversationId"]))
	if orphanConversation.ArchivedAt == nil {
		t.Fatalf("the unassigned child session is archived: %+v", orphanConversation)
	}
	assignedConversation := ConversationRowOf(runtime.store, kernelString(assigned["conversationId"]))
	if assignedConversation.ArchivedAt != nil {
		t.Fatalf("a project child session stays active: %+v", assignedConversation)
	}
	if runtime.store.Task(orphanConversation.AnchorTaskId).Paused == 0 {
		t.Fatal("archiving the unassigned child session pauses its task")
	}
	if runtime.store.Task(assignedConversation.AnchorTaskId).Paused != 0 {
		t.Fatal("the assigned child task stays runnable")
	}
	view := fleetProjection(runtime.store, "")
	for _, agent := range view.Agents {
		if agent.Id == kernelString(orphan["agentId"]) {
			t.Fatalf("the archived child agent is still in the fleet: %+v", agent)
		}
	}
}

func TestFleetHidesTerminalUnassignedGraphAgents(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id)
		VALUES('t-orphan','global-workspace','probe',90,'completed','c-global')`)
	RegisterNodeAgent(fixture.store, "t-orphan", "probe", "worker", "global-workspace")
	fleetSnapshotsForget(fixture.store)
	view := fixture.fleet(t, "")
	for _, agent := range view.Agents {
		if agent.TaskId == "t-orphan" {
			t.Fatalf("a terminal unassigned graph stays hidden: %+v", agent)
		}
	}
}
