package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestConversationsGroupByProjectAndSkipArchived(t *testing.T) {
	list := []conversationSummary{
		{ID: "a1", Title: "甲会话", ProjectID: "13-Graph"},
		{ID: "b1", Title: "乙会话", ProjectID: "mygo"},
		{ID: "a2", Title: "", ProjectID: "13-Graph", OpenQuestions: 2},
		{ID: "c1", Title: "旧会话", ProjectID: "13-Graph", ArchivedAt: pointer(int64(1))},
		{ID: "d1", Title: "散会话"},
	}
	groups := groupByProject(list)
	if len(groups) != 3 || groups[0].project != "13-Graph" || groups[0].items[0].ID != "a1" || groups[1].project != "mygo" || groups[2].project != "未分组" {
		t.Fatalf("groups %+v", groups)
	}
	if len(groups[0].items) != 2 {
		t.Fatalf("the archived conversation must be skipped: %+v", groups[0].items)
	}
	rows := sidebarRows(groups)
	if rows[0].project != "13-Graph" || rows[1].id != "a1" || rows[2].label != "（无标题） · 2 待答" {
		t.Fatalf("rows %+v", rows)
	}
}

func pointer[T any](value T) *T { return &value }

func TestShellSidebarSwitchesConversation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"c1","title":"会话一","projectId":"13-Graph","archivedAt":null},
				{"id":"c2","title":"会话二","projectId":"mygo","archivedAt":null}
			]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}]}`))
		case "/api/conversations/c2":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话二"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.load()
	if state.chat.active != "c1" {
		t.Fatalf("the newest conversation opens first, active %q", state.chat.active)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("13-Graph") || !tester.HasText("mygo") {
		t.Fatalf("the sidebar must show the project groups, texts %q", tester.Texts())
	}
	if !tester.HasText("来自会话一") {
		t.Fatalf("the pane must show the first conversation, texts %q", tester.Texts())
	}
	if err := tester.Click("会话二"); err != nil {
		t.Fatalf("click 会话二: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.chat.active != "c2" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.chat.active != "c2" || !tester.HasText("来自会话二") {
		t.Fatalf("clicking a row must switch the pane, active %q texts %q", state.chat.active, tester.Texts())
	}
}

func TestShellReportsAnEmptyConversationList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations" {
			w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	state := newShellState(server.URL, "")
	state.load()
	if state.status != "还没有会话。" {
		t.Fatalf("status %q", state.status)
	}
}
