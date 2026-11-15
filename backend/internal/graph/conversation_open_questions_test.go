// graph:table-writes-exempt: a test seeds the questions it reads back
package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestConversationQuestionsAreFilteredToOpenWhenAsked(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/open-questions','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	kernelExec(store.DB, `INSERT INTO questions(id,task_id,node_id,kind,data,status,owner)
		VALUES('q-open','t','master','ask','{"question":"open"}','open','user')`)
	kernelExec(store.DB, `INSERT INTO questions(id,task_id,node_id,kind,data,status,owner)
		VALUES('q-closed','t','master','ask','{"question":"closed"}','answered','user')`)
	kernelExec(store.DB, `INSERT INTO nodes(task_id,id,spec) VALUES('t','master','{}')`)
	store.RecordOperationIntent("op", "t", "master", nil, 1, "{}", 0, "")
	kernelExec(store.DB, `INSERT INTO rsi_continuations(request_id,operation_id,task_id,node_id,commit_sha,state)
		VALUES('r','op','t','master','sha','ready')`)
	app := CreateApp(&TaskRuntime{store: store, kernel: NewKernelStore(store)}, AppOptions{})
	view := func(query string) map[string]any {
		request := httptest.NewRequest(http.MethodGet, "/api/conversations/c"+query, nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("read conversation: %v", err)
		}
		return body
	}
	questions := func(query string) []map[string]any {
		raw, _ := view(query)["questions"].([]any)
		out := []map[string]any{}
		for _, item := range raw {
			out = append(out, item.(map[string]any))
		}
		return out
	}
	all := questions("")
	if len(all) != 2 {
		t.Fatalf("the default view keeps every question, got %d", len(all))
	}
	open := questions("?questions=open")
	if len(open) != 1 || open[0]["id"] != "q-open" {
		t.Fatalf("questions=open keeps only open questions, got %v", open)
	}
	if continuations, _ := view("")["continuations"].([]any); len(continuations) != 1 {
		t.Fatalf("the default view keeps continuations, got %v", continuations)
	}
	if continuations, _ := view("?lean=1")["continuations"].([]any); len(continuations) != 0 {
		t.Fatalf("lean skips continuations, got %v", continuations)
	}
}
