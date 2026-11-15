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

func TestTrajectoryPayloadKeepsOnlyTheDisplayWindow(t *testing.T) {
	requests := make([]TrajectoryRequest, 70)
	for index := range requests {
		requests[index] = TrajectoryRequest{At: int64(index)}
	}
	turns := make([]TrajectoryTurn, 25)
	for index := range turns {
		turns[index] = TrajectoryTurn{Index: index + 1}
	}
	trajectory := &ConversationTrajectory{Requests: requests, Turns: turns}
	trimConversationTrajectoryForDisplay(trajectory)
	if len(trajectory.Requests) != 60 || trajectory.RequestOffset != 10 {
		t.Fatalf("the display window keeps the newest requests and remembers the prefix, got %d offset %d", len(trajectory.Requests), trajectory.RequestOffset)
	}
	if trajectory.Requests[0].At != 10 {
		t.Fatalf("the first kept request is the 11th original, got %d", trajectory.Requests[0].At)
	}
	if len(trajectory.Turns) != 20 || trajectory.Turns[0].Index != 6 {
		t.Fatalf("the display window keeps the newest turns, got %d first %d", len(trajectory.Turns), trajectory.Turns[0].Index)
	}
}
