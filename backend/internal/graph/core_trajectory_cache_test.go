// graph:table-writes-exempt: a test seeds the conversation it reads back
package graph

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestConversationTrajectoryServesTheStoredSnapshotUntilHistoryChanges(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "trajectory.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/trajectory-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	app := CreateApp(&TaskRuntime{store: store, kernel: NewKernelStore(store)}, AppOptions{})
	get := func() string {
		request := httptest.NewRequest(http.MethodGet, "/api/conversations/c/trajectory", nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		return recorder.Body.String()
	}

	if body := get(); !strings.Contains(body, `"conversationId":"c"`) {
		t.Fatalf("first read builds the trajectory, got %s", body)
	}
	kernelExec(store.DB, `UPDATE trajectories SET payload='{"conversationId":"stored"}' WHERE conversation_id='c'`)
	if body := get(); !strings.Contains(body, `"conversationId":"stored"`) {
		t.Fatalf("an unchanged history serves the stored snapshot, got %s", body)
	}
	AppendMessage(store, MessageInput{ConversationID: "c", Role: MessageRoleUser, Kind: "chat", Text: "next", State: MessageStateDone})
	if body := get(); !strings.Contains(body, `"conversationId":"c"`) {
		t.Fatalf("a new message rebuilds the trajectory, got %s", body)
	}
}
