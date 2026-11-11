package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	if active := state.active(); active == nil || active.active != "c1" {
		t.Fatalf("the newest conversation opens first, active %q", state.activeID)
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
	for state.activeID != "c2" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.activeID != "c2" || !tester.HasText("来自会话二") {
		t.Fatalf("clicking a row must switch the pane, active %q texts %q", state.activeID, tester.Texts())
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

func TestTabsKeepBothConversationsOpen(t *testing.T) {
	reloads := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"c1","title":"甲","projectId":"13-Graph","archivedAt":null},
				{"id":"c2","title":"乙","projectId":"13-Graph","archivedAt":null}
			]`))
		case "/api/conversations/c1":
			reloads["c1"]++
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"甲的内容"}]}`))
		case "/api/conversations/c2":
			reloads["c2"]++
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"乙的内容"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.load()
	state.selectConversation("c2")
	if len(state.tabs) != 2 || state.activeID != "c2" {
		t.Fatalf("both conversations must stay open, tabs %d active %q", len(state.tabs), state.activeID)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("› 乙") || !tester.HasText("甲") {
		t.Fatalf("the tab bar must show both tabs, texts %q", tester.Texts())
	}
	state.selectConversation("c1")
	if reloads["c1"] != 1 {
		t.Fatalf("a tab that is already open must not reload, loads %v", reloads)
	}
	state.closeTab("c2")
	if len(state.tabs) != 1 || state.activeID != "c1" {
		t.Fatalf("closing a tab must keep the other one, tabs %d active %q", len(state.tabs), state.activeID)
	}
	state.closeTab("c1")
	if len(state.tabs) != 0 || state.activeID != "" {
		t.Fatalf("closing the last tab leaves no active conversation, tabs %d active %q", len(state.tabs), state.activeID)
	}
}

func shellServer(t *testing.T, posts map[string]string) *httptest.Server {
	t.Helper()
	archived := map[string]bool{"c2": true}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			payload := make([]byte, 4096)
			read, _ := r.Body.Read(payload)
			posts[r.URL.Path] = string(payload[:read])
			switch {
			case strings.HasSuffix(r.URL.Path, "/archive"):
				archived[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/conversations/"), "/archive")] = true
			case strings.HasSuffix(r.URL.Path, "/unarchive"):
				delete(archived, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/conversations/"), "/unarchive"))
			}
			w.Write([]byte(`{}`))
			return
		}
		if r.URL.Path == "/api/conversations" {
			rows := []string{`{"id":"c1","title":"甲","projectId":"13-Graph","archivedAt":null}`}
			if archived["c1"] {
				rows[0] = `{"id":"c1","title":"甲","projectId":"13-Graph","archivedAt":1793178492000}`
			}
			if archived["c2"] {
				rows = append(rows, `{"id":"c2","title":"旧会话","projectId":"13-Graph","archivedAt":1793178492555}`)
			}
			w.Write([]byte("[" + strings.Join(rows, ",") + "]"))
			return
		}
		if r.URL.Path == "/api/conversations/c1" {
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"甲的回复"}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}

func TestShellCreatesAConversationInAChosenProject(t *testing.T) {
	posts := map[string]string{}
	server := shellServer(t, posts)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.load()
	tester := ui.NewTester(state.view, 1000, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if tester.HasText("第一条消息（可留空）") {
		t.Fatalf("the create form must stay closed until asked, texts %q", tester.Texts())
	}
	if err := tester.Click("新建会话"); err != nil {
		t.Fatalf("click 新建会话: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("创建") || !tester.HasText("13-Graph") {
		t.Fatalf("the create form must offer the project and a create button, texts %q", tester.Texts())
	}
	if err := tester.Click("13-Graph"); err != nil {
		t.Fatalf("click the project: %v", err)
	}
	state.newText = "帮我看看这个仓库"
	state.createConversation()
	posted := posts["/api/conversations"]
	for _, wanted := range []string{`"projectId":"13-Graph"`, `"text":"帮我看看这个仓库"`, `"requestId"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
	if state.creating || state.newText != "" {
		t.Fatalf("creating must reset after the call, creating %v text %q", state.creating, state.newText)
	}
}

func TestShellArchivesAndRestoresConversations(t *testing.T) {
	posts := map[string]string{}
	server := shellServer(t, posts)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.load()
	if len(state.tabs) != 1 || state.activeID != "c1" {
		t.Fatalf("tabs %d active %q", len(state.tabs), state.activeID)
	}
	state.archiveConversation("c1")
	if _, ok := posts["/api/conversations/c1/archive"]; !ok {
		t.Fatalf("归档必须打 archive 路由，posts %v", posts)
	}
	if len(state.tabs) != 0 || state.activeID != "" {
		t.Fatalf("归档后必须关掉那个标签，tabs %d active %q", len(state.tabs), state.activeID)
	}
	state.showArchived = true
	state.load()
	archived := ""
	for _, row := range state.rows {
		if row.id == "c2" {
			archived = row.label
		}
	}
	if archived != "旧会话（已归档）" {
		t.Fatalf("已归档的会话必须标出来，label %q", archived)
	}
	state.unarchiveConversation("c2")
	if _, ok := posts["/api/conversations/c2/unarchive"]; !ok {
		t.Fatalf("取消归档必须打 unarchive 路由，posts %v", posts)
	}
}

func TestSelectingTheSameConversationTwiceKeepsOneTab(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"messages":[{"role":"user","text":"开始"}]}`))
	}))
	defer server.Close()
	s := newShellState(server.URL, "tok")
	var waiting sync.WaitGroup
	for click := 0; click < 8; click++ {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			s.selectConversation("c1")
		}()
	}
	waiting.Wait()
	if len(s.tabs) != 1 {
		t.Fatalf("八次点同一个会话留下了 %d 个标签，界面上就是同一个标题重复出现", len(s.tabs))
	}
	if s.activeID != "c1" {
		t.Fatalf("the conversation that was clicked must end up active, got %q", s.activeID)
	}
}
