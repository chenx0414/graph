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
