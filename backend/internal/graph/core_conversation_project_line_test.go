// graph:table-writes-exempt: the test seeds the rows the digest reads
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func digestFixture(t *testing.T, role string, projectID any) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "digest.sqlite"))
	t.Cleanup(store.Close)
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('13-graph','/tmp/13-graph','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t1','13-graph','Main',1,'chatting')")
	if projectID == nil {
		kernelExec(store.DB, "INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','w','t1','Main',1,0,?)", role)
	} else {
		kernelExec(store.DB, "INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1',?,'w','t1','Main',1,0,?)", projectID, role)
	}
	return store
}

func TestAGlobalConversationChoosesItsOwnProject(t *testing.T) {
	store := digestFixture(t, string(ConversationGlobal), nil)
	digest := ConversationDigest(store, "c1")
	if strings.Contains(digest, "ask the user to choose one from the configured projects") {
		t.Fatalf("the digest must not turn a decision the supervisor can make into a user question: %s", digest)
	}
	if !strings.Contains(digest, "choose it yourself") {
		t.Fatalf("the global supervisor must be told it decides the project: %s", digest)
	}
	if !strings.Contains(digest, "apply_rsi_change") {
		t.Fatalf("the digest must name this checkout as the supervisor's own workspace: %s", digest)
	}
}

func TestAProjectThreadNamesItsBoundProject(t *testing.T) {
	bound := ConversationDigest(digestFixture(t, string(ConversationProject), "13-graph"), "c1")
	if !strings.Contains(bound, "Project: 13-graph (root /tmp/13-graph)") {
		t.Fatalf("a bound project thread must name its project and root: %s", bound)
	}
	if strings.Contains(bound, "choose it yourself") {
		t.Fatalf("a project thread is bound to one project, so it must not be told to choose: %s", bound)
	}
}
