package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseTasksAcceptsTheDaemonList(t *testing.T) {
	tasks, err := parseTasks([]byte(`[{"id":"a","request":"do it","status":"running","openQuestions":2}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ID != "a" || tasks[0].OpenQuestions != 2 {
		t.Fatalf("tasks %+v", tasks)
	}
	empty, err := parseTasks([]byte("  "))
	if err != nil || len(empty) != 0 {
		t.Fatalf("an empty body must read as no tasks: %v %v", empty, err)
	}
	if _, err := parseTasks([]byte("{")); err == nil {
		t.Fatal("garbage must be reported")
	}
}

func TestTaskDecisionsPrimeThenReportChangesOnly(t *testing.T) {
	state := newNotificationState()
	if decisions, _ := taskDecisions(state, []taskSummary{{ID: "a", Request: "工作中", Status: "running", OpenQuestions: 0}}); len(decisions) != 0 {
		t.Fatalf("the first poll must only prime, got %+v", decisions)
	}

	decisions, _ := taskDecisions(state, []taskSummary{{ID: "a", Request: "工作中", Status: "running", OpenQuestions: 1}})
	if len(decisions) != 1 || decisions[0].Title != "任务需要处理" || decisions[0].TaskID != "a" {
		t.Fatalf("a new question must notify: %+v", decisions)
	}

	if decisions, _ := taskDecisions(state, []taskSummary{{ID: "a", Request: "工作中", Status: "running", OpenQuestions: 1}}); len(decisions) != 0 {
		t.Fatalf("an unchanged poll must stay quiet: %+v", decisions)
	}

	decisions, _ = taskDecisions(state, []taskSummary{{ID: "a", Request: "工作中", Status: "completed", OpenQuestions: 1}})
	if len(decisions) != 1 || decisions[0].Title != "任务已完成" {
		t.Fatalf("finishing must notify: %+v", decisions)
	}

	decisions, _ = taskDecisions(state, []taskSummary{{ID: "a", Request: "工作中", Status: "failed", OpenQuestions: 1}})
	if len(decisions) != 1 || decisions[0].Title != "任务失败" {
		t.Fatalf("failing must notify: %+v", decisions)
	}
}

func TestTaskDecisionsCountOpenQuestionsAndClipTheBody(t *testing.T) {
	state := newNotificationState()
	state.Primed = true
	long := ""
	for index := 0; index < 200; index++ {
		long += "字"
	}
	decisions, open := taskDecisions(state, []taskSummary{{ID: "a", Request: long, Status: "discussing", OpenQuestions: 2}})
	if open != 2 {
		t.Fatalf("open total %d", open)
	}
	if len(decisions) != 1 || len([]rune(decisions[0].Body)) != 80 {
		t.Fatalf("body must be clipped to 80 runes: %+v", decisions)
	}
}

func TestFetchTasksReadsTheDaemonWithTheSessionCookie(t *testing.T) {
	var cookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie = r.Header.Get("Cookie")
		if r.URL.Path != "/api/tasks" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(`[{"id":"a","request":"x","status":"completed","openQuestions":0}]`))
	}))
	defer server.Close()

	tasks, err := fetchTasks(newAPIClient(server.URL, "tok\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Status != "completed" {
		t.Fatalf("tasks %+v", tasks)
	}
	if cookie != "graph_session=tok" {
		t.Fatalf("cookie %q", cookie)
	}
}
