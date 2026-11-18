package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBoardDataWaitsUntilTheMainConversationIsReady(t *testing.T) {
	requests := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.URL.Path
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	shell := newShellState(server.URL, "tok")
	shell.blockBoardDataUntilConversation()
	shell.ensureUsage()
	shell.ensureFleet()
	shell.ensureTrajectory()
	if shell.usage != nil {
		t.Fatal("usage must not load while the main conversation is still opening")
	}
	select {
	case path := <-requests:
		t.Fatalf("board data requested before the conversation was ready: %s", path)
	default:
	}

	shell.markConversationReady()
	shell.ensureUsage()
	select {
	case path := <-requests:
		if path != "/api/insights" {
			t.Fatalf("the released board load asks for insights, got %s", path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the released board load never asked for insights")
	}
}
