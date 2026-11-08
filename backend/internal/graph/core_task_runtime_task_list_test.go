// graph:table-writes-exempt: a test seeds the rows it then lists
package graph

import (
	"path/filepath"
	"testing"
)

func listIDs(t *testing.T, user *TaskRuntimeUser) []string {
	t.Helper()
	ids := []string{}
	for _, row := range user.List() {
		ids = append(ids, kernelString(row["id"]))
	}
	return ids
}

func containsID(ids []string, id string) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func seedListFixture(t *testing.T, store *TaskStore) {
	t.Helper()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-list-fixture','[]')")
	store.CreateConversation("conv-retire", nil, "", "", "retire me", 1, 1)
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task-retireable','p','conv-retire','retire me',1,0,1,'completed')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task-plain','p','plain task',1,0,2,'stopped')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task-chat','p','chat only',1,0,3,'chatting')")
}

func TestRetiredConversationHidesItsTaskAndRestoreBringsItBack(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	seedListFixture(t, store)
	user := &TaskRuntimeUser{runtime: &TaskRuntime{store: store}}

	before := listIDs(t, user)
	if !containsID(before, "task-retireable") || !containsID(before, "task-plain") {
		t.Fatalf("baseline list missing live tasks: %v", before)
	}
	if containsID(before, "task-chat") {
		t.Fatalf("chatting task must never be listed: %v", before)
	}

	store.ArchiveConversation("conv-retire", NowMillis())
	retired := listIDs(t, user)
	if containsID(retired, "task-retireable") {
		t.Fatalf("task of a retired conversation still listed: %v", retired)
	}
	if !containsID(retired, "task-plain") {
		t.Fatalf("retiring one conversation hid an unrelated task: %v", retired)
	}

	store.RestoreConversation("conv-retire")
	restored := listIDs(t, user)
	if !containsID(restored, "task-retireable") {
		t.Fatalf("restoring the conversation did not bring its task back: %v", restored)
	}
}
