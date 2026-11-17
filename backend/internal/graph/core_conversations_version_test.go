// graph:table-writes-exempt: a test seeds the conversations it versions around
package graph

import (
	"path/filepath"
	"testing"
)

func conversationsVersionFixture(t *testing.T) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "conversations.sqlite"))
	kernelExec(store.DB, `INSERT INTO projects(id,root,grants) VALUES('p','/tmp/version','[]')`)
	kernelExec(store.DB, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-one','p','Main',1,'chatting','c-one')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,project_id,workspace_project_id,title,created_seq,created_at,role,anchor_task_id)
		VALUES('c-one','p','p','19-xhs-mini-tools',1,1000,'project','t-one')`)
	return store
}

func TestConversationsVersionFollowsANewProjectConversation(t *testing.T) {
	store := conversationsVersionFixture(t)
	before := conversationsVersion(store)
	if before == "" {
		t.Fatal("a store with one project conversation must have a version")
	}
	if again := conversationsVersion(store); again != before {
		t.Fatalf("the version changed without a change: %q then %q", before, again)
	}
	kernelExec(store.DB, `INSERT INTO projects(id,root,grants) VALUES('p2','/tmp/version-2','[]')`)
	kernelExec(store.DB, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-two','p2','Main',2,'chatting','c-two')`)
	kernelExec(store.DB, `INSERT INTO conversations(id,project_id,workspace_project_id,title,created_seq,created_at,role,anchor_task_id)
		VALUES('c-two','p2','p2','20-another',2,2000,'project','t-two')`)
	if after := conversationsVersion(store); after == before {
		t.Fatalf("a new project conversation has to move the version, still %q", after)
	}
}

func TestConversationsVersionFollowsARenameAndAnArchive(t *testing.T) {
	store := conversationsVersionFixture(t)
	renamed := conversationsVersion(store)
	kernelExec(store.DB, `UPDATE conversations SET title='19-renamed' WHERE id='c-one'`)
	afterRename := conversationsVersion(store)
	if afterRename == renamed {
		t.Fatal("a rename has to move the version, otherwise the sidebar keeps showing the old title")
	}
	kernelExec(store.DB, `UPDATE conversations SET archived_at=3000 WHERE id='c-one'`)
	if afterArchive := conversationsVersion(store); afterArchive == afterRename {
		t.Fatal("an archive has to move the version, otherwise the row stays in the sidebar")
	}
}
