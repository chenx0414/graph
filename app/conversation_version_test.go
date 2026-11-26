package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChatRefreshAsksForTheVersionBeforeTheWholeTranscript(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "token"), []byte("tok"), 0o600)
	full, version := 0, 0
	loadQuery := ""
	current := "v1"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c/version":
			version++
			_, _ = w.Write([]byte(`{"version":"` + current + `"}`))
		case "/api/conversations/c":
			full++
			if full == 1 {
				loadQuery = r.URL.RawQuery
			}
			_, _ = w.Write([]byte(`{"version":"` + current + `","messages":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	claimShellOwner()
	source := newConversationChatSource(newAPIClient(server.URL, "tok"), "c")
	chat := &chatState{source: source}
	if err := source.Load(chat); err != nil {
		t.Fatal(err)
	}
	if full != 1 {
		t.Fatalf("the first load reads the transcript, got %d", full)
	}
	if !strings.Contains(loadQuery, "limit=60") || !strings.Contains(loadQuery, "questions=open") || !strings.Contains(loadQuery, "lean=1") {
		t.Fatalf("the first load asks for one compact page, got %q", loadQuery)
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

func TestChatRefreshFetchesOnlyMessagesAfterTheNewestOne(t *testing.T) {
	current := "v1"
	queries := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c/version":
			_, _ = w.Write([]byte(`{"version":"` + current + `"}`))
		case "/api/conversations/c":
			queries = append(queries, r.URL.RawQuery)
			if strings.Contains(r.URL.RawQuery, "after=5") {
				if current == "v2" {
					_, _ = w.Write([]byte(`{"version":"v2","messages":[{"id":"m2","seq":6,"role":"user","kind":"chat","text":"two","state":"done"}]}`))
					return
				}
				_, _ = w.Write([]byte(`{"version":"` + current + `","messages":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"version":"v1","messages":[{"id":"m1","seq":5,"role":"user","kind":"chat","text":"one","state":"done"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	claimShellOwner()
	source := newConversationChatSource(newAPIClient(server.URL, "tok"), "c")
	chat := &chatState{source: source}
	if err := source.Load(chat); err != nil {
		t.Fatal(err)
	}
	if len(chat.messages) != 1 {
		t.Fatalf("the first load reads the transcript, got %d", len(chat.messages))
	}
	current = "v2"
	if changed, err := source.Refresh(chat); err != nil || !changed {
		t.Fatalf("the new turn is a change, changed %v err %v", changed, err)
	}
	if len(chat.messages) != 2 {
		t.Fatalf("the incremental refresh merges the new message, got %d", len(chat.messages))
	}
	if !strings.Contains(queries[len(queries)-1], "after=5") {
		t.Fatalf("the refresh asks for messages after the newest one, queries %v", queries)
	}
	current = "v3"
	if _, err := source.Refresh(chat); err != nil {
		t.Fatal(err)
	}
	if len(chat.messages) != 2 {
		t.Fatalf("a version-only change keeps the transcript, got %d", len(chat.messages))
	}
}
