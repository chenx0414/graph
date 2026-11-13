// graph:table-writes-exempt: the test seeds the rows the reply projection reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestConversationOutputAnswersAfterRsiMarksTheOperationReplied(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "conversation-reply.sqlite"))
	defer store.Close()
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`,
		`INSERT INTO tasks(id,project_id,conversation_id,request,created_seq,phase) VALUES('t1','p1','c1','goal',1,'chatting')`,
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','p1','t1','Main',1,0,'global')`,
		`INSERT INTO nodes(task_id,id,spec) VALUES('t1','master','{"role":"master"}')`,
		`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,replied_at) VALUES('op1','t1','master',1,'{}','dispatched',0,0,123)`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	operation := Operation{Id: "op1", TaskId: "t1", NodeId: "master", Kind: "agent", Attempt: 1}
	result := OperationResult{Outcome: "completed", Output: map[string]any{"text": "最终回答"}}
	RecordConversationOutput(store, operation, result)
	RecordConversationOutput(store, operation, result)
	rows := kernelRows(store.Db, "SELECT id FROM messages WHERE conversation_id='c1' AND role='assistant' AND kind='chat'")
	if len(rows) != 1 {
		t.Fatalf("the model reply must appear exactly once after RSI marked replied, messages %+v", rows)
	}
}
