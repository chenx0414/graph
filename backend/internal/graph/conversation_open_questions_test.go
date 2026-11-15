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
	app := CreateApp(&TaskRuntime{store: store, kernel: NewKernelStore(store)}, AppOptions{})
	questions := func(query string) []map[string]any {
		request := httptest.NewRequest(http.MethodGet, "/api/conversations/c"+query, nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		var body struct {
			Questions []map[string]any `json:"questions"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("read questions: %v", err)
		}
		return body.Questions
	}
	all := questions("")
	if len(all) != 2 {
		t.Fatalf("the default view keeps every question, got %d", len(all))
	}
	open := questions("?questions=open")
	if len(open) != 1 || open[0]["id"] != "q-open" {
		t.Fatalf("questions=open keeps only open questions, got %v", open)
	}
}
