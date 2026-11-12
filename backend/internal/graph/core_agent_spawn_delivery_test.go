// graph:table-writes-exempt: the test seeds the rows the delivery reads
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDeliverChildResultWakesTheSupervisorParent(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "child-delivery.sqlite"))
	defer store.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("exec %q: %v", query, err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`)
	exec(`INSERT INTO tasks(id,project_id,conversation_id,request,created_seq,phase) VALUES('t-parent','p1','c-parent','parent',1,'chatting')`)
	exec(`INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t-child','p1','child',2,'chatting')`)
	exec(`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,project_id,role)
		VALUES('c-parent','p1','t-parent','Parent',1,0,'p1','project')`)
	exec(`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,project_id,role)
		VALUES('c-child','p1','t-child','Child',2,0,'p1','child')`)
	exec(`INSERT INTO nodes(task_id,id,spec,status) VALUES('t-parent','master','{"role":"master"}','idle')`)
	NewKernelStore(store)
	exec(`INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,project_id,workspace,model,created_at,metadata)
		VALUES('c-parent','','project','project','Parent','c-parent','t-parent','p1','/tmp/p1','m',0,'{}')`)
	exec(`INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,project_id,workspace,model,created_at,metadata)
		VALUES('c-child','c-parent','child','child','Child','c-child','t-child','p1','/tmp/child','m',0,'{}')`)
	child := ConversationRowOf(store, "c-child")
	DeliverChildResult(store, child, Operation{Id: "op-child", Kind: "agent"}, OperationResult{
		Outcome: "completed", Output: map[string]any{"text": "研究完成，产物在 artifacts/research@1"},
	})
	message := kernelRow(store.Db, "SELECT role,kind,text,state FROM messages WHERE conversation_id='c-parent' AND kind='agent_result'")
	if message == nil || kernelString(message["role"]) != "user" || kernelString(message["state"]) != "pending" {
		t.Fatalf("parent message = %+v", message)
	}
	if !strings.Contains(kernelString(message["text"]), "研究完成") {
		t.Fatalf("parent message text = %q", kernelString(message["text"]))
	}
	if kernelRow(store.Db, "SELECT 1 FROM wake_intents WHERE task_id='t-parent' AND kind='agent_result' AND dedupe_key='c-child'") == nil {
		t.Fatal("the parent wake is missing")
	}
	if kernelRow(store.Db, "SELECT 1 FROM events WHERE task_id='t-parent' AND type='agent.result'") == nil {
		t.Fatal("the parent result event is missing")
	}
}
