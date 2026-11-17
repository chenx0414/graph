// graph:table-writes-exempt: a test seeds the conversations and master nodes it routes around
package graph

import (
	"path/filepath"
	"testing"
)

func routeFixture(t *testing.T) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "routing.sqlite"))
	NewKernelStore(store)
	kernelExec(store.DB, `INSERT INTO projects(id,root,grants) VALUES('global','/tmp/routing-global','[]')`)
	kernelExec(store.DB, `INSERT INTO projects(id,root,grants) VALUES('p','/tmp/routing-project','[]')`)
	kernelExec(store.DB, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id)
		VALUES('t-global','global','Main',1,'chatting','c-global')`)
	kernelExec(store.DB, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id)
		VALUES('t-proj','p','Project',2,'running','c-proj')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c-global',NULL,'global','t-global','Main',1,1000,'global')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c-proj','p','p','t-proj','19-xhs-mini-tools',2,2000,'project')`)
	kernelExec(store.DB, `INSERT INTO nodes(task_id,id,spec) VALUES('t-global','master','{"role":"master","action":"supervise"}')`)
	kernelExec(store.DB, `INSERT INTO nodes(task_id,id,spec) VALUES('t-proj','master','{"role":"master","action":"supervise"}')`)
	return store
}

func routeStageOf(t *testing.T, store *TaskStore, questionId string) string {
	t.Helper()
	row := kernelRow(store.Db, "SELECT COALESCE(route_stage,'') AS stage FROM questions WHERE id=?", questionId)
	if row == nil {
		t.Fatalf("question %s is missing", questionId)
	}
	return kernelString(row["stage"])
}

func globalWakesFor(t *testing.T, store *TaskStore) int {
	t.Helper()
	return int(kernelInt(kernelRow(store.Db, "SELECT COUNT(*) AS count FROM wake_intents WHERE task_id='t-global'")["count"]))
}

func TestAFailedProjectSupervisorReachesTheGlobalSupervisor(t *testing.T) {
	store := routeFixture(t)
	inserted := InsertQuestion(store, QuestionInput{
		TaskId: "t-proj", NodeId: "master", Kind: "execution_failed",
		Data: map[string]any{"error": "Provider answered HTTP 400"},
	})
	if inserted.Owner != QuestionOwnerMain {
		t.Fatalf("an execution failure belongs to main, got %q", inserted.Owner)
	}
	if stage := routeStageOf(t, store, inserted.Id); stage != "global" {
		t.Fatalf("a project supervisor that failed its own turn cannot fix it: the problem has to reach the global supervisor, stage %q", stage)
	}
	if wakes := globalWakesFor(t, store); wakes != 1 {
		t.Fatalf("the global supervisor has to be woken about the problem, wakes %d", wakes)
	}
}

func TestAProblemItsOwnSupervisorCanHandleStaysLocal(t *testing.T) {
	store := routeFixture(t)
	inserted := InsertQuestion(store, QuestionInput{
		TaskId: "t-proj", NodeId: "master", Kind: "git_dirty",
		Data: map[string]any{"reason": "the worktree has uncommitted changes"},
	})
	if stage := routeStageOf(t, store, inserted.Id); stage != "" {
		t.Fatalf("a locally answerable problem must not be escalated, stage %q", stage)
	}
	if wakes := globalWakesFor(t, store); wakes != 0 {
		t.Fatalf("nothing has to wake the global supervisor, wakes %d", wakes)
	}
}
