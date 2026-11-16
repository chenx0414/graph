package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheChatHidesTheWaitingNoteAboveTheComposer(t *testing.T) {
	chat := &chatState{status: chatWaitStatus, messages: []transcriptMessage{{ID: "m1", Role: "user", Text: "问"}}}
	tester := ui.NewTester(chat.view, 900, 700)
	frames(tester)
	if tester.HasText(chatWaitStatus) {
		t.Fatalf("the waiting note must stay out of the chat, texts %q", tester.Texts())
	}
}

func TestWhiteboardContextRefreshesWhenTheChatChanges(t *testing.T) {
	version := atomic.Value{}
	version.Store("v1")
	trajectoryReads := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/conversations/c1/version":
			_, _ = w.Write([]byte(`{"version":"` + version.Load().(string) + `"}`))
		case r.URL.Path == "/api/conversations/c1/trajectory":
			reads := trajectoryReads.Add(1)
			tokens := 100
			if reads > 1 {
				tokens = 240
			}
			_, _ = w.Write([]byte(`{"conversationId":"c1","totals":{"context":{"lastTokens":` + strconv.Itoa(tokens) + `}}}`))
		case r.URL.Path == "/api/conversations/c1":
			if r.URL.RawQuery != "" && version.Load().(string) == "v2" {
				_, _ = w.Write([]byte(`{"version":"v2","messages":[{"id":"m2","seq":2,"role":"user","kind":"chat","text":"下一轮","state":"done"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1","messages":[{"id":"m1","seq":1,"role":"user","kind":"chat","text":"问","state":"done"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	shell.ensureTrajectory()
	deadline := time.Now().Add(2 * time.Second)
	for (shell.trajectory.data == nil || shell.trajectory.data.Totals.Context.LastTokens != 100) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if shell.trajectory.data == nil {
		t.Fatalf("the first context never loaded: %q", shell.trajectory.failed)
	}
	version.Store("v2")
	if !shell.refresh() {
		t.Fatal("the new turn is a chat change")
	}
	for shell.trajectory.data.Totals.Context.LastTokens != 240 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := shell.trajectory.data.Totals.Context.LastTokens; got != 240 {
		t.Fatalf("the whiteboard context follows the chat, got %d", got)
	}
	if trajectoryReads.Load() < 2 {
		t.Fatalf("the context is read again after the chat change, reads %d", trajectoryReads.Load())
	}
}
