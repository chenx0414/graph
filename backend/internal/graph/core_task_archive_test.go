// graph:table-writes-exempt: the test seeds the task rows it archives
package graph

import (
	"path/filepath"
	"testing"
)

func seedArchiveTask(t *testing.T, store *TaskStore, id string) {
	t.Helper()
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES(?,?,?,?,?)", id, "p", "work", 1, "completed")
}

func TestArchivingATaskHidesItAndRestoringBringsItBack(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p", t.TempDir(), "[]")
	seedArchiveTask(t, store, "t-archive")

	if !store.ArchiveTask("t-archive") {
		t.Fatal("archiving a live task must report that it changed something")
	}
	if row := kernelRow(store.DB, "SELECT archived_at FROM tasks WHERE id='t-archive'"); kernelInt(row["archived_at"]) == 0 {
		t.Fatal("archiving must record when it happened")
	}
	if store.ListedTaskCount() != 0 {
		t.Fatalf("an archived task must leave the list, got %d", store.ListedTaskCount())
	}
	if !store.RestoreTask("t-archive") {
		t.Fatal("restoring an archived task must report that it changed something")
	}
	if store.ListedTaskCount() != 1 {
		t.Fatalf("a restored task must return to the list, got %d", store.ListedTaskCount())
	}
}

func TestDeletingATaskRemovesItAndRefusesWhileItRuns(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p", t.TempDir(), "[]")
	seedArchiveTask(t, store, "t-live")
	kernelExec(store.DB, "UPDATE tasks SET phase='running' WHERE id='t-live'")

	if _, err := store.DeleteTask("t-live"); err == nil {
		t.Fatal("deleting a running task must be refused")
	}
	kernelExec(store.DB, "UPDATE tasks SET phase='completed' WHERE id='t-live'")
	deleted, err := store.DeleteTask("t-live")
	if err != nil {
		t.Fatalf("deleting a finished task: %v", err)
	}
	if deleted.Rows == 0 {
		t.Fatal("deleting must report what it removed")
	}
	if row := kernelRow(store.DB, "SELECT id FROM tasks WHERE id='t-live'"); row != nil {
		t.Fatal("the task row must be gone")
	}
	if row := kernelRow(store.DB, "SELECT count(*) AS n FROM artifacts WHERE task_id='t-live'"); kernelInt(row["n"]) != 0 {
		t.Fatal("the task's artifacts must be gone with it")
	}
}

func TestArchivingKeepsTheTaskEvidence(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p", t.TempDir(), "[]")
	seedArchiveTask(t, store, "t-evidence")
	kernelExec(store.DB, `INSERT INTO artifacts(artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,
		object_path,size,media_type,title,producer_node_id,producer_instance_id,visibility,trust,state,metadata,created_at)
		VALUES('a1',1,'task','t-evidence','t-evidence','p','shared','report.json','shared/report.json','sha-a1',
		'/tmp/a1',10,'application/json','Report','n1','i-n1','task','trusted','published','{}',1)`)

	if !store.ArchiveTask("t-evidence") {
		t.Fatal("archiving must succeed")
	}
	if row := kernelRow(store.DB, "SELECT count(*) AS n FROM artifacts WHERE task_id='t-evidence'"); kernelInt(row["n"]) != 1 {
		t.Fatalf("archiving must keep the task artifacts, got %d", kernelInt(row["n"]))
	}
	if !store.RestoreTask("t-evidence") {
		t.Fatal("restoring must succeed")
	}
	if row := kernelRow(store.DB, "SELECT count(*) AS n FROM artifacts WHERE task_id='t-evidence'"); kernelInt(row["n"]) != 1 {
		t.Fatalf("a restored task must still hold its artifact, got %d", kernelInt(row["n"]))
	}
}
