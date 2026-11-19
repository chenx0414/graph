package main

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"
)

type mainAgentBootstrap struct {
	mutex     sync.Mutex
	globalHit int
	created   bool
}

func (b *mainAgentBootstrap) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	empty := true
	mux.HandleFunc("/api/conversations", func(w http.ResponseWriter, r *http.Request) {
		b.mutex.Lock()
		defer b.mutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if empty {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"g-new","title":"Main","role":"global","archivedAt":null}]`))
	})
	mux.HandleFunc("/api/orchestration/global", func(w http.ResponseWriter, r *http.Request) {
		b.mutex.Lock()
		defer b.mutex.Unlock()
		b.globalHit++
		empty = false
		b.created = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"conversationId":"g-new","taskId":"t-new","role":"global"}`))
	})
	mux.HandleFunc("/api/conversations/g-new", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"chat","text":"新会话就绪","state":"done"}]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func TestClickingMainAgentOnAnEmptyConsoleStartsTheGlobalThread(t *testing.T) {
	bootstrap := &mainAgentBootstrap{}
	server := bootstrap.server(t)
	state := newShellState(server.URL, "tok")
	state.load()
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if state.supervisorID != "" {
		t.Fatalf("the fixture starts without a global thread, got %q", state.supervisorID)
	}
	card, ok := tester.Find("main agent 会话")
	if !ok {
		t.Fatalf("the main agent card never rendered, texts %q", tester.Texts())
	}
	tester.ClickAt(card.X+card.W/2, card.Y+card.H/2)
	for attempt := 0; attempt < 500 && !strings.Contains(strings.Join(tester.Texts(), " "), "新会话就绪"); attempt++ {
		runtime.Gosched()
		frames(tester)
	}
	bootstrap.mutex.Lock()
	hits, created := bootstrap.globalHit, bootstrap.created
	bootstrap.mutex.Unlock()
	if hits == 0 {
		t.Fatal("clicking Main Agent on an empty console must ask the console for the global thread")
	}
	if !created {
		t.Fatal("the console never created the global thread")
	}
	if state.supervisorID != "g-new" {
		t.Fatalf("the created global thread becomes the supervisor, got %q", state.supervisorID)
	}
	if state.activeID != "g-new" {
		t.Fatalf("the created global thread is opened, active %q", state.activeID)
	}
	if !strings.Contains(strings.Join(tester.Texts(), " "), "新会话就绪") {
		t.Fatalf("the new global thread shows its transcript, texts %q", tester.Texts())
	}
}
