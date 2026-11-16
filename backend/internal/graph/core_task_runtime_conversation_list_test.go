// graph:table-writes-exempt: the test seeds the rows the list reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestConversationListHidesChildAgents(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "conversation-list.sqlite"))
	defer store.Close()
	for _, statement := range []string{
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c-user','w','t1','User',1,0,'legacy')`,
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c-child','w','t2','Child',2,0,'child')`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	runtime := &TaskRuntime{store: store}
	list := runtime.Conversations().List(false)
	if len(list) != 1 || kernelString(list[0]["id"]) != "c-user" {
		t.Fatalf("conversation list = %+v", list)
	}
}

func TestConversationListHidesArchivedProjects(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "conversation-list.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')")
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p2','/tmp/p2','[]')")
	kernelExec(store.DB, "UPDATE projects SET archived_at=1 WHERE id='p1'")
	for _, statement := range []string{
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','p1','p1','t1','One',1,0,'project')`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c2','p2','p2','t2','Two',2,0,'project')`,
	} {
		kernelExec(store.DB, statement)
	}
	list := (&TaskRuntime{store: store}).Conversations().List(false)
	if len(list) != 1 || kernelString(list[0]["id"]) != "c2" {
		t.Fatalf("archived projects stay out of the conversation list: %+v", list)
	}
}
