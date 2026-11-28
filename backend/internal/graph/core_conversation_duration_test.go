// graph:table-writes-exempt: a test seeds the invocation rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

// seedAnsweredRound writes one settled answer plus the invocations the agent ran
// while producing it: the model call, a slow tool-bound stretch, and the final
// call. The round's own duration is the span from the first dispatch to the last
// settlement, which is what the chat shows above the answer.
func seedAnsweredRound(t *testing.T, store *TaskStore, conversationId, operationId string) {
	t.Helper()
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,1,0,?,?)",
		"task-"+operationId, "p", conversationId, "r", 1, "completed")
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec) VALUES(?,?,?)", "task-"+operationId, "master", `{"role":"master"}`)
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
        VALUES(?,?,'task-'||?,'Main',1,0,'global')`, conversationId, "p", operationId)
	store.RecordOperationIntent(operationId, "task-"+operationId, "master", nil, 1, "{}", 0, "")
	kernelExec(store.DB, "UPDATE operations SET state='settled',dispatched_at=?,settled_at=? WHERE id=?", int64(1_000_000), int64(1_009_000), operationId)
	for index, span := range []int64{0, 4_000, 9_000} {
		id := "inv-" + operationId + "-" + itoa(index)
		store.OpenInvocation(id, operationId, "inst", "m", "completion")
		kernelExec(store.DB, "UPDATE invocations SET dispatched_at=?,settled_at=? WHERE id=?",
			int64(1_000_000)+span, int64(1_000_000)+span+500, id)
	}
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,text,state,operation_id,seq,turn,created_at,updated_at)
        VALUES(?,?,'assistant','chat','做完了。','done',?,1,1,?,?)`,
		"msg-"+operationId, conversationId, operationId, int64(1_000_000), int64(1_009_000))
}

func TestASettledAnswerReportsHowLongItsOperationReallyRan(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-duration-fixture','[]')")
	seedAnsweredRound(t, store, "conv", "op-answer")

	limit := 50
	messages := ListMessages(store, "conv", MessageQuery{Limit: &limit})
	if len(messages) != 1 {
		t.Fatalf("the fixture wrote one message, got %d", len(messages))
	}
	if got := messages[0].DurationMs; got != 9_500 {
		t.Fatalf("a settled answer must report the span of its operation, got %d ms", got)
	}
}

func TestAnUnansweredMessageReportsNoDuration(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-duration-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t-prompt','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
        VALUES('conv','p','t-prompt','Main',1,0,'global')`)
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,text,state,seq,turn,created_at,updated_at)
        VALUES('m1','conv','user','chat','跑一下','delivered',1,1,1000,1000)`)

	limit := 50
	messages := ListMessages(store, "conv", MessageQuery{Limit: &limit})
	if len(messages) != 1 {
		t.Fatalf("the fixture wrote one message, got %d", len(messages))
	}
	if got := messages[0].DurationMs; got != 0 {
		t.Fatalf("a prompt with no operation behind it must not invent a duration, got %d ms", got)
	}
}
