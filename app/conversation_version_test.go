package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestChatRefreshAsksForTheVersionBeforeTheWholeTranscript(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "token"), []byte("tok"), 0o600)
	full, version := 0, 0
	current := "v1"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c/version":
			version++
			_, _ = w.Write([]byte(`{"version":"` + current + `"}`))
		case "/api/conversations/c":
			full++
			_, _ = w.Write([]byte(`{"version":"` + current + `","messages":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	source := newConversationChatSource(newAPIClient(server.URL, "tok"), "c")
	chat := &chatState{}
	if err := source.Load(chat); err != nil {
		t.Fatal(err)
	}
	if full != 1 {
		t.Fatalf("the first load reads the transcript, got %d", full)
	}
	if changed, err := source.Refresh(chat); err != nil || changed {
		t.Fatalf("an unchanged version is not a change, changed %v err %v", changed, err)
	}
	if full != 1 {
		t.Fatalf("the unchanged poll must skip the transcript, got %d full reads", full)
	}
	current = "v2"
	if _, err := source.Refresh(chat); err != nil {
		t.Fatalf("a new version refreshes the transcript: %v", err)
	}
	if full != 2 {
		t.Fatalf("the changed version reads the transcript again, got %d", full)
	}
}
