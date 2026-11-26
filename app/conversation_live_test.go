package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// liveShell wires a shell against a fake console and opens the main agent
// conversation, as the app does when it starts.
func liveShell(t *testing.T, handler http.HandlerFunc) *shellState {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	return state
}

// waitForChatText keeps drawing frames while the clock moves, so a chat that
// polls on its own frames has the chance to show what arrived. It never
// switches conversations and never asks for a refresh by hand.
func waitForChatText(t *testing.T, tester *ui.Tester, text string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		advance(tester, 600*time.Millisecond)
		render(tester)
		if tester.HasText(text) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%q never showed up without switching conversations, texts %q", text, tester.Texts())
}

func mainAgentList() string {
	return `[{"id":"g1","title":"Main","role":"global","archivedAt":null},
		{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null}]`
}

// TestTheFinishedMainAgentAnswerAppearsWithoutSwitchingConversations is wish 6:
// the user sits in the main agent conversation, the agent finishes, and the
// final answer must show up on its own.
func TestTheFinishedMainAgentAnswerAppearsWithoutSwitchingConversations(t *testing.T) {
	var mu sync.Mutex
	finished := false
	handler := func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			_, _ = w.Write([]byte(mainAgentList()))
		case "/api/conversations/version":
			_, _ = w.Write([]byte(`{"version":"rows-1"}`))
		case "/api/conversations/g1/version":
			mu.Lock()
			done := finished
			mu.Unlock()
			if done {
				_, _ = w.Write([]byte(`{"version":"v2"}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1"}`))
		case "/api/conversations/g1":
			mu.Lock()
			done := finished
			mu.Unlock()
			if done {
				_, _ = w.Write([]byte(`{"version":"v2","messages":[
					{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
					{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"全部完成，七个问题都修好了。","state":"done"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1","messages":[
				{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
				{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"正在整理结果","state":"streaming"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	state := liveShell(t, handler)
	tester := frames(newTester(state.view, 1440, 900))
	waitForChatText(t, tester, "正在整理结果")
	mu.Lock()
	finished = true
	mu.Unlock()
	waitForChatText(t, tester, "全部完成，七个问题都修好了。")
	if tester.HasText("正在整理结果") {
		t.Fatalf("the running placeholder must give way to the final answer, texts %q", tester.Texts())
	}
}

// TestTheFinishedAnswerShowsEvenWhenTheVersionStandsStill covers the console
// that keeps one version while the reply settles: the open conversation must
// still read the settled transcript instead of trusting the version alone.
func TestTheFinishedAnswerShowsEvenWhenTheVersionStandsStill(t *testing.T) {
	var mu sync.Mutex
	finished := false
	handler := func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			_, _ = w.Write([]byte(mainAgentList()))
		case "/api/conversations/version":
			_, _ = w.Write([]byte(`{"version":"rows-1"}`))
		case "/api/conversations/g1/version":
			_, _ = w.Write([]byte(`{"version":"v1"}`))
		case "/api/conversations/g1":
			mu.Lock()
			done := finished
			mu.Unlock()
			if done {
				_, _ = w.Write([]byte(`{"version":"v1","messages":[
					{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
					{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"全部完成，七个问题都修好了。","state":"done"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1","messages":[
				{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
				{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"正在整理结果","state":"streaming"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	state := liveShell(t, handler)
	tester := frames(newTester(state.view, 1440, 900))
	waitForChatText(t, tester, "正在整理结果")
	mu.Lock()
	finished = true
	mu.Unlock()
	waitForChatText(t, tester, "全部完成，七个问题都修好了。")
}

// TestSwitchingBackToTheMainAgentShowsItsContentAtOnce is wish 5: coming back
// to a conversation that already has content shows that content immediately,
// and only then asks the console for the newest reply.
func TestSwitchingBackToTheMainAgentShowsItsContentAtOnce(t *testing.T) {
	var mu sync.Mutex
	// The first read of the main agent conversation goes through, so the window
	// opens on its content; the hold starts when the user leaves it.
	hold := false
	released := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(released) }) }
	asked := make(chan struct{}, 16)
	handler := func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			_, _ = w.Write([]byte(mainAgentList()))
		case "/api/conversations/version":
			_, _ = w.Write([]byte(`{"version":"rows-1"}`))
		case "/api/conversations/g1/version":
			mu.Lock()
			held := hold
			mu.Unlock()
			if held {
				_, _ = w.Write([]byte(`{"version":"v2"}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1"}`))
		case "/api/conversations/g1":
			mu.Lock()
			held := hold
			mu.Unlock()
			if held {
				select {
				case asked <- struct{}{}:
				default:
				}
				<-released
				_, _ = w.Write([]byte(`{"version":"v2","messages":[
					{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
					{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"主控旧内容","state":"done"},
					{"id":"m3","seq":3,"role":"assistant","kind":"chat","text":"主控新内容","state":"done"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1","messages":[
				{"id":"m1","seq":1,"role":"user","kind":"chat","text":"修好七个问题","state":"delivered"},
				{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"主控旧内容","state":"done"}]}`))
		case "/api/conversations/p1":
			_, _ = w.Write([]byte(`{"version":"p1","messages":[
				{"id":"n1","seq":1,"role":"assistant","kind":"chat","text":"项目会话内容","state":"done"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	t.Cleanup(release)
	state := liveShell(t, handler)
	tester := frames(newTester(state.view, 1440, 900))
	if !tester.HasText("主控旧内容") {
		t.Fatalf("the main agent conversation must open with its content, texts %q", tester.Texts())
	}
	state.selectConversation("p1")
	tester = frames(tester)
	if !tester.HasText("项目会话内容") {
		t.Fatalf("the project conversation must open, texts %q", tester.Texts())
	}

	switched := make(chan struct{})
	mu.Lock()
	hold = true
	mu.Unlock()
	go func() {
		state.selectConversation("g1")
		close(switched)
	}()
	select {
	case <-switched:
	case <-time.After(5 * time.Second):
		t.Fatal("switching back to the main agent conversation waited for the console")
	}
	tester = frames(tester)
	if !tester.HasText("主控旧内容") {
		t.Fatalf("the cached main agent content must show at once, texts %q", tester.Texts())
	}
	if tester.HasText("主控新内容") {
		t.Fatalf("the newest reply must wait for the console, texts %q", tester.Texts())
	}
	if tester.HasText("正在读取会话…") {
		t.Fatalf("a cached conversation must not fall back to a loading placeholder, texts %q", tester.Texts())
	}
	// The side panels read their own data in the background and may paint a skeleton
	// for a frame or two while the chat already shows its cached content. What must
	// not happen is the window staying on placeholders.
	for frame := 0; frame < 120 && tester.HasText("加载占位"); frame++ {
		render(tester)
	}
	if tester.HasText("加载占位") {
		t.Fatalf("the side panels stayed on placeholders, texts %q", tester.Texts())
	}
	if !tester.HasText("主控旧内容") {
		t.Fatalf("the cached main agent content must stay on screen, texts %q", tester.Texts())
	}

	mu.Lock()
	hold = false
	mu.Unlock()
	release()
	waitForChatText(t, tester, "主控新内容")
}
