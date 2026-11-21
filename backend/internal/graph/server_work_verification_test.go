package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerificationWorkStartsOnlyFromTheConfirmedRevision(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-b", "main"}, {"commit", "--allow-empty", "-m", "Target baseline"}} {
		if result := Git(repo, args, nil, nil); result.Code != 0 {
			t.Fatalf("git %v: %s", args, result.Stderr)
		}
	}
	runtime := OpenTaskRuntime(GraphServerOptions{
		StateDir: filepath.Join(t.TempDir(), "state"),
		Projects: []ProjectConfig{{Id: "p1", Root: repo}},
		Live:     &TaskRuntimeLive{Entries: func() []ConfiguredModel { return nil }},
	})
	t.Cleanup(runtime.Close)
	runtime.git.PrepareProject("p1", false, false)
	thread := runtime.OpenProjectThread("p1", "open-project")
	app := CreateApp(runtime, AppOptions{})
	source := AppendMessage(runtime.store, MessageInput{
		ConversationID: thread.ConversationID, Role: MessageRoleUser, Kind: "chat", Text: "Set the product value to new",
	})
	work := runtime.CreateWork(WorkCreate{
		ConversationID: thread.ConversationID, ProjectID: "p1", SourceMessageID: source.Id,
		Brief: "Set product.txt to new", Acceptance: []string{"Read the new value"},
	}, "create-work")
	post := func(path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(CanonicalJSON(body)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://127.0.0.1")
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		return recorder
	}
	definition := verificationTestDefinition(t, true)
	created := post("/api/graphs", map[string]any{
		"conversationId": thread.ConversationID, "targetBranch": "main", "definition": definition, "requestId": "unconfirmed",
	})
	if !strings.Contains(created.Body.String(), "confirmed work draft") {
		t.Errorf("direct creation must require confirmation: %d %s", created.Code, created.Body)
	}
	raw := map[string]any{
		"requirementVersion": float64(work.Revision), "summary": work.Brief, "definition": definition,
		"acceptance": []any{map[string]any{"id": "behavior", "description": "Read the new value", "checkNode": "check"}},
	}
	draft := runtime.PutWorkDraft(work.ID, WorkDraftInput{WorkRevision: work.Revision, Proposal: raw}, "first-draft")
	raw["summary"] = "Use the revised parser behavior"
	draftRevision := draft.DraftRevision
	current := runtime.PutWorkDraft(work.ID, WorkDraftInput{
		WorkRevision: work.Revision, Proposal: raw, ExpectedDraftRevision: &draftRevision,
	}, "revise-draft")
	raw["summary"] = "Final parser behavior"
	latest := runtime.PutWorkDraft(work.ID, WorkDraftInput{
		WorkRevision: work.Revision, Proposal: raw, NewVersion: true,
	}, "supersede-draft")
	path := "/api/orchestration/work/" + work.ID + "/confirm"
	confirm := func(version, revision int64, requestID string) *httptest.ResponseRecorder {
		return post(path, map[string]any{
			"workRevision": work.Revision, "version": version, "draftRevision": revision,
			"targetBranch": "main", "graphKey": "parser", "requestId": requestID,
		})
	}
	stale := confirm(current.Version, draft.DraftRevision, "old-confirmation")
	if stale.Code == http.StatusOK || !strings.Contains(stale.Body.String(), "stale_draft") {
		t.Fatalf("old revision must be refused: %d %s", stale.Code, stale.Body)
	}
	if superseded := confirm(current.Version, current.DraftRevision, "superseded-confirmation"); !strings.Contains(superseded.Body.String(), "stale_draft") {
		t.Errorf("a superseded draft must require a new confirmation: %d %s", superseded.Code, superseded.Body)
	}
	valid := confirm(latest.Version, latest.DraftRevision, "user-confirmation")
	var receipt WorkGraph
	if err := json.Unmarshal(valid.Body.Bytes(), &receipt); valid.Code != http.StatusOK || err != nil || receipt.State != "ready" || receipt.GraphID == nil {
		t.Fatalf("confirmed work must create a graph: %d %s", valid.Code, valid.Body)
	}
	defer runtime.git.ReleaseWorkcopies(*receipt.GraphID)
	transcript := topologyRequest(t, app, "/api/conversations/"+thread.ConversationID)
	if !strings.Contains(transcript.Body.String(), "Final parser behavior") || !strings.Contains(transcript.Body.String(), `"confirmed":true`) {
		t.Fatalf("the conversation must show the approved draft: %s", transcript.Body)
	}
	graphs := topologyRequest(t, app, "/api/orchestration/work/"+work.ID+"/graphs")
	if !strings.Contains(graphs.Body.String(), *receipt.GraphID) {
		t.Fatalf("confirmed revision must be discoverable: %s", graphs.Body)
	}
}
