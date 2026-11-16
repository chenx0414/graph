// graph:table-writes-exempt: the test seeds the conversation a notice lands in
package graph

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestADeferredToolResumeIsMarkedAsANotice(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/deferred-notice','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	queueDeferredToolResume(store, DeferredToolCall{
		ConversationId: "c", ToolCallId: "call_1", ToolName: "bash", State: DeferredToolSettled,
	})
	row := kernelRow(store.DB, "SELECT data FROM messages WHERE conversation_id='c' AND role='user' ORDER BY seq DESC LIMIT 1")
	var data struct {
		Source struct {
			Kind    string `json:"kind"`
			Form    string `json:"form"`
			Summary string `json:"summary"`
		} `json:"source"`
	}
	if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
		t.Fatal(err)
	}
	if data.Source.Kind != "tool_settled" || data.Source.Form != "notice" || data.Source.Summary != "bash 已结束" {
		t.Fatalf("the resume notice carries its source, got %+v", data.Source)
	}
}
