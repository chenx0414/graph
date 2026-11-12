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
