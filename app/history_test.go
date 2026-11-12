package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func conversationMessagesJSON(from, to int) string {
	parts := make([]string, 0, to-from+1)
	for seq := from; seq <= to; seq++ {
		parts = append(parts, `{"id":"m`+strconv.Itoa(seq)+`","seq":`+strconv.Itoa(seq)+`,"role":"user","text":"第`+strconv.Itoa(seq)+`句"}`)
	}
	return `{"messages":[` + strings.Join(parts, ",") + `]}`
}

func historyPagingServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/conversations/c1/history"):
			requests.Add(1)
			if r.URL.Query().Get("before") != "61" || r.URL.Query().Get("limit") != "200" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Write([]byte(conversationMessagesJSON(1, 60)))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(conversationMessagesJSON(61, 260)))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server, requests
}

func TestReachingTheTopFetchesOlderHistory(t *testing.T) {
	server, requests := historyPagingServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.messages) != 200 || state.oldestSeq != 61 || state.noMoreHistory {
		t.Fatalf("opened %d messages oldest %d noMore %v", len(state.messages), state.oldestSeq, state.noMoreHistory)
	}
	state.ensureHistory()
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) < 260 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(state.messages) != 260 || state.oldestSeq != 1 || !state.noMoreHistory {
		t.Fatalf("paged %d messages oldest %d noMore %v", len(state.messages), state.oldestSeq, state.noMoreHistory)
	}
	if requests.Load() != 1 {
		t.Fatalf("one page means one history request, got %d", requests.Load())
	}
	state.ensureHistory()
	time.Sleep(20 * time.Millisecond)
	if requests.Load() != 1 {
		t.Fatalf("the last page must stop the fetching, got %d requests", requests.Load())
	}
}

func TestScrollingUpLoadsOlderHistory(t *testing.T) {
	server, _ := historyPagingServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := ui.NewTester(state.view, 700, 500)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if len(state.messages) != 200 {
		t.Fatalf("opened %d messages", len(state.messages))
	}
	state.list.ScrollTo(0, ui.Start)
	for frame := 0; frame < 4; frame++ {
		tester.Frame()
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) < 260 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(state.messages) != 260 {
		t.Fatalf("reaching the top must load the older page, got %d messages", len(state.messages))
	}
}

func TestFilteredMessagesDoNotEndTheHistory(t *testing.T) {
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/conversations/c1/history"):
			requests.Add(1)
			w.Write([]byte(conversationMessagesJSON(1, 60)))
		case r.URL.Path == "/api/conversations/c1":
			parts := make([]string, 0, 200)
			for seq := 61; seq <= 260; seq++ {
				role := "user"
				if seq%4 == 0 {
					role = "activity"
				}
				parts = append(parts, `{"id":"m`+strconv.Itoa(seq)+`","seq":`+strconv.Itoa(seq)+`,"role":"`+role+`","text":"第`+strconv.Itoa(seq)+`句"}`)
			}
			w.Write([]byte(`{"messages":[` + strings.Join(parts, ",") + `]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.messages) != 150 {
		t.Fatalf("filtered roles are not chat messages, got %d", len(state.messages))
	}
	if state.noMoreHistory {
		t.Fatal("a full raw page means there is older history, even if roles were filtered")
	}
	if state.oldestSeq != 61 {
		t.Fatalf("the page cursor is the oldest raw message, got %d", state.oldestSeq)
	}
	state.ensureHistory()
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) < 210 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(state.messages) != 210 || requests.Load() != 1 {
		t.Fatalf("the older page must load, messages %d requests %d", len(state.messages), requests.Load())
	}
}

func TestLoadingOlderHistoryKeepsTheReaderInPlace(t *testing.T) {
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/conversations/c1/history"):
			requests.Add(1)
			before := r.URL.Query().Get("before")
			if before == "201" {
				w.Write([]byte(conversationMessagesJSON(1, 200)))
				return
			}
			w.Write([]byte(`{"messages":[]}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(conversationMessagesJSON(201, 400)))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := ui.NewTester(state.view, 700, 500)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	state.list.ScrollTo(0, ui.Start)
	for frame := 0; frame < 4; frame++ {
		tester.Frame()
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) < 400 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 4; frame++ {
		tester.Frame()
	}
	if len(state.messages) != 400 {
		t.Fatalf("the older page must load, got %d messages", len(state.messages))
	}
	if requests.Load() != 1 {
		t.Fatalf("one reach of the top loads one page, got %d requests", requests.Load())
	}
	if !tester.HasText("第201句") {
		t.Fatalf("the reader stays on the message they were reading, texts %q", tester.Texts())
	}
	for frame := 0; frame < 6; frame++ {
		tester.Frame()
	}
	time.Sleep(50 * time.Millisecond)
	if requests.Load() != 1 {
		t.Fatalf("staying at the loaded page must not fetch again, got %d requests", requests.Load())
	}
	state.list.ScrollTo(0, ui.Start)
	for frame := 0; frame < 6; frame++ {
		tester.Frame()
	}
	deadline = time.Now().Add(2 * time.Second)
	for requests.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if requests.Load() != 2 {
		t.Fatalf("a new reach of the top asks once more, got %d requests", requests.Load())
	}
	for frame := 0; frame < 6; frame++ {
		tester.Frame()
	}
	if requests.Load() != 2 {
		t.Fatalf("the empty page ends the history, got %d requests", requests.Load())
	}
}

func TestRefreshingKeepsTheHistoryAlreadyLoaded(t *testing.T) {
	server, _ := historyPagingServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.ensureHistory()
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) < 260 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	state.refresh()
	if len(state.messages) != 260 {
		t.Fatalf("a refresh must keep the pages read before it, got %d messages", len(state.messages))
	}
	if state.messages[0].Seq != 1 {
		t.Fatalf("the oldest message stays first, seq %d", state.messages[0].Seq)
	}
}
