package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

func TestHoveringAProjectConversationArchivesIt(t *testing.T) {
	archived := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/lifecycle") {
			_, _ = w.Write([]byte(`{"archived":false,"activeExecutions":0}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requestId, _ := body["requestId"].(string)
		archived <- r.URL.Path + "|" + requestId
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.conversations = []conversationSummary{
		{ID: "c1", Role: "project", ProjectID: "13-Graph", Title: "13-Graph"},
		{ID: "c2", Role: "project", ProjectID: "p2", Title: "Other"},
	}
	state.activeID = "c2"
	tester := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c, theme.Dark())
		ui.Column(c).Width(300).Children(func() { state.conversationList(c) })
	}, 320, 400)
	tester.Frame()
	row, ok := tester.Find("13-Graph")
	if !ok {
		t.Fatalf("the conversation row is drawn, texts %q", tester.Texts())
	}
	tester.Move(row.X+row.W/2, row.Y+row.H/2)
	tester.Frame()
	if _, ok := tester.Find("归档项目 13-Graph"); !ok {
		t.Fatalf("hovering reveals the archive action, texts %q", tester.Texts())
	}
	if err := tester.Click("归档项目 13-Graph"); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-archived:
		parts := strings.SplitN(received, "|", 2)
		if parts[0] != "/api/projects/13-Graph/archive" {
			t.Fatalf("the hover action archives the project, got %s", received)
		}
		if len(parts) != 2 || strings.TrimSpace(parts[1]) == "" {
			t.Fatalf("the archive action carries a request id, got %s", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the archive request never went out")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(state.conversations) != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(state.conversations) != 1 || state.conversations[0].ID != "c2" {
		t.Fatalf("the archived project leaves the list, conversations %+v", state.conversations)
	}
	if state.activeID != "c2" {
		t.Fatalf("archiving another project keeps the open conversation, active %q", state.activeID)
	}
}

func TestArchivingTheActiveProjectSelectsTheSupervisor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations/g1" {
			_, _ = w.Write([]byte(`{"messages":[]}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.supervisorID = "g1"
	state.conversations = []conversationSummary{
		{ID: "c1", Role: "project", ProjectID: "13-Graph", Title: "13-Graph"},
		{ID: "c2", Role: "project", ProjectID: "Other", Title: "Other"},
	}
	state.activeID = "c1"
	state.archiveProject("13-Graph")
	deadline := time.Now().Add(2 * time.Second)
	for (state.activeID != "g1" || len(state.conversations) != 1) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.activeID != "g1" {
		t.Fatalf("archiving the open project returns to Main, active %q", state.activeID)
	}
	if len(state.conversations) != 1 || state.conversations[0].ID != "c2" {
		t.Fatalf("the archived project leaves the list, conversations %+v", state.conversations)
	}
}

func TestALongProjectNameKeepsTheArchiveActionAtTheRight(t *testing.T) {
	long := strings.Repeat("很长的项目名字", 8)
	state := newShellState("http://127.0.0.1:1", "tok")
	state.conversations = []conversationSummary{{ID: "c1", Role: "project", ProjectID: long, Title: long}}
	tester := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c, theme.Dark())
		ui.Column(c).Width(300).Children(func() { state.conversationList(c) })
	}, 320, 400)
	tester.Frame()
	row, ok := tester.Find(long)
	if !ok {
		t.Fatalf("the long project row is drawn, texts %q", tester.Texts())
	}
	tester.Move(row.X+10, row.Y+row.H/2)
	tester.Frame()
	button, ok := tester.Find("归档项目 " + long)
	if !ok {
		t.Fatalf("a long title must not push the archive action away, texts %q", tester.Texts())
	}
	if button.X < 220 || button.X+button.W > 310 {
		t.Fatalf("the archive action stays at the row's right edge, rect %+v", button)
	}
}

func TestArchivingAProjectWithRunningWorkAsksFirst(t *testing.T) {
	posted := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/lifecycle") {
			_, _ = w.Write([]byte(`{"archived":false,"activeExecutions":2}`))
			return
		}
		posted <- r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	state := newShellState(server.URL, "tok")
	state.conversations = []conversationSummary{{ID: "c1", Role: "project", ProjectID: "13-Graph", Title: "13-Graph"}}
	state.activeID = "c1"
	state.requestArchive("13-Graph", "13-Graph")
	deadline := time.Now().Add(2 * time.Second)
	for state.archiveConfirm == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.archiveConfirm == nil {
		t.Fatal("running work opens the archive confirmation")
	}
	tester := ui.NewTester(state.view, 1200, 800)
	frames(tester)
	if !tester.HasText("归档项目？") || !tester.HasText("2 个正在运行的任务") {
		t.Fatalf("the confirmation lists the running work, texts %q", tester.Texts())
	}
	select {
	case <-posted:
		t.Fatal("nothing is archived before the confirmation")
	default:
	}
	if err := tester.Click("取消"); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if state.archiveConfirm != nil {
		t.Fatal("cancelling keeps the project")
	}
	state.requestArchive("13-Graph", "13-Graph")
	for state.archiveConfirm == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	tester = ui.NewTester(state.view, 1200, 800)
	frames(tester)
	if err := tester.Click("归档"); err != nil {
		t.Fatal(err)
	}
	select {
	case path := <-posted:
		if path != "/api/projects/13-Graph/archive" {
			t.Fatalf("confirming archives the project, got %s", path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("confirming never archived the project")
	}
}

func TestAnArchivedProjectHasNoArchiveAction(t *testing.T) {
	archivedAt := int64(1)
	state := newShellState("http://127.0.0.1:1", "tok")
	state.conversations = []conversationSummary{{ID: "c1", Role: "project", ProjectID: "p1", Title: "p1", ProjectArchivedAt: &archivedAt}}
	tester := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c, theme.Dark())
		ui.Column(c).Width(300).Children(func() { state.conversationList(c) })
	}, 320, 400)
	tester.Frame()
	row, ok := tester.Find("p1")
	if !ok {
		t.Fatalf("the archived project row is drawn, texts %q", tester.Texts())
	}
	tester.Move(row.X+10, row.Y+row.H/2)
	tester.Frame()
	if _, ok := tester.Find("归档项目 p1"); ok {
		t.Fatalf("an archived project offers no archive action, texts %q", tester.Texts())
	}
	if !tester.HasText("已归档") {
		t.Fatalf("an archived project says so, texts %q", tester.Texts())
	}
}

func TestArchivingAProjectForgetsCachedFleetData(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.conversations = []conversationSummary{
		{ID: "c1", Role: "project", ProjectID: "p1"},
		{ID: "c2", Role: "project", ProjectID: "p2"},
	}
	state.activeID = "c2"
	state.fleet.data = &fleetSnapshot{RootID: "p1"}
	state.fleet.global = &fleetSnapshot{RootID: "g1"}
	state.dropArchivedProject("p1")
	if state.fleet.data != nil || state.fleet.global != nil {
		t.Fatalf("archiving forgets the cached fleet, data %+v global %+v", state.fleet.data, state.fleet.global)
	}
}
