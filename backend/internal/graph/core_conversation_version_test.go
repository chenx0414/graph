// graph:table-writes-exempt: a test seeds the conversation it versions
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestConversationVersionFollowsItsTranscript(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/version-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	before := conversationVersion(store, "c")
	AppendMessage(store, MessageInput{ConversationID: "c", Role: MessageRoleUser, Kind: "chat", Text: "next", State: MessageStateDone})
	after := conversationVersion(store, "c")
	if before == after {
		t.Fatalf("a new message must advance the conversation version, before %q after %q", before, after)
	}
}

func TestConversationVersionReadsMessagesThroughTheirConversationIndex(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	rows := kernelRows(store.DB, "EXPLAIN QUERY PLAN SELECT COALESCE(MAX(updated_at),0) FROM messages WHERE conversation_id=?", "c")
	detail := ""
	for _, row := range rows {
		detail += kernelString(row["detail"])
	}
	if !strings.Contains(detail, "messages_conversation_updated") {
		t.Fatalf("the version probe must use the per-conversation timestamp index, got %s", detail)
	}
}
