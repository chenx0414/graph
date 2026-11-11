package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheConversationListShowsOneConversationPerProject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations" {
			w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null},
				{"id":"p2","title":"mygo","projectId":"mygo","role":"project","archivedAt":null},
				{"id":"old1","title":"旧聊天","projectId":"13-Graph","role":"legacy","archivedAt":null},
				{"id":"old2","title":"另一段旧聊天","projectId":"13-Graph","role":"legacy","archivedAt":null}
			]`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.load()
	if len(state.conversations) != 2 {
		t.Fatalf("only the project conversations belong in the list, got %+v", state.conversations)
	}
	if state.conversations[0].ProjectID != "13-Graph" || state.conversations[1].ProjectID != "mygo" {
		t.Fatalf("conversations %+v", state.conversations)
	}
	if state.supervisorID != "g1" {
		t.Fatalf("the global main agent thread must stay pinned, got %q", state.supervisorID)
	}
}

func TestShellSidebarSwitchesConversation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"c1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null},
				{"id":"c2","title":"mygo","projectId":"mygo","role":"project","archivedAt":null}
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
		t.Fatalf("the first project opens first, active %q", state.activeID)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	frames(tester)
	if !tester.HasText("13-Graph") || !tester.HasText("mygo") {
		t.Fatalf("the sidebar must show both projects, texts %q", tester.Texts())
	}
	if !tester.HasText("来自会话一") {
		t.Fatalf("the pane must show the first conversation, texts %q", tester.Texts())
	}
	if err := tester.Click("mygo"); err != nil {
		t.Fatalf("click mygo: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for (state.activeID != "c2" || state.active() == nil) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	frames(tester)
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
	if state.status != "还没有项目会话。" {
		t.Fatalf("status %q", state.status)
	}
}

func TestSelectingTheSameConversationTwiceKeepsOneChat(t *testing.T) {
	loads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations/c1" {
			loads++
		}
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
	deadline := time.Now().Add(2 * time.Second)
	for s.active() == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if s.active() == nil {
		t.Fatal("the conversation that was clicked must end up open")
	}
	if s.activeID != "c1" {
		t.Fatalf("the conversation that was clicked must end up active, got %q", s.activeID)
	}
	if loads > 1 {
		t.Fatalf("八次点同一个会话只该读一次，读到了 %d 次", loads)
	}
}

func TestSelectingAnEmptyConversationOpensNothing(t *testing.T) {
	s := newShellState("http://127.0.0.1:1", "tok")
	s.selectConversation("")
	if s.active() != nil {
		t.Fatal("a row without an id cannot be opened")
	}
	if s.activeID != "" {
		t.Fatalf("nothing should become active, got %q", s.activeID)
	}
}

func TestTheSidebarReloadsWhenTheDaemonComesBack(t *testing.T) {
	var up atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`[{"id":"c1","title":"13-Graph","projectId":"13-Graph","role":"project"}]`))
	}))
	defer server.Close()
	s := newShellState(server.URL, "tok")
	if s.refresh() {
		t.Fatal("a failed list read must not report a change")
	}
	if !strings.Contains(s.status, "读不到会话列表") {
		t.Fatalf("the shell must say why the sidebar is empty, got %q", s.status)
	}
	up.Store(true)
	if !s.refresh() {
		t.Fatal("the sidebar must reload by itself once the daemon answers again, instead of waiting for a click")
	}
	if len(s.conversations) == 0 || s.status != "" {
		t.Fatalf("the sidebar did not come back: rows %d status %q", len(s.conversations), s.status)
	}
}

func TestAdoptingANewConsoleAddressWhenTheDaemonMoved(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "console.json"), []byte(`{"url":"http://127.0.0.1:60001","pid":1,"mode":"execute","startedAt":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "session-token"), []byte("fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newShellState("http://127.0.0.1:50000", "stale")
	if !s.adoptConsole(Paths{StateDir: stateDir}) {
		t.Fatal("a daemon that moved to another port must be adopted, otherwise the window keeps talking to a closed socket")
	}
	if s.api.address != "http://127.0.0.1:60001" || s.api.token != "fresh" {
		t.Fatalf("adopted %q with token %q", s.api.address, s.api.token)
	}
	if s.adoptConsole(Paths{StateDir: stateDir}) {
		t.Fatal("the same address is not a change")
	}
}
