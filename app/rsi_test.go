package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPendingRestartNeedsAnIDAndPermission(t *testing.T) {
	var status rsiStatus
	status.CanRestart = true
	status.PendingRestart = &struct {
		ID string `json:"id"`
	}{ID: "act-1"}
	if id, ok := pendingRestart(status); !ok || id != "act-1" {
		t.Fatalf("id %q ok=%v", id, ok)
	}
	status.CanRestart = false
	if _, ok := pendingRestart(status); ok {
		t.Fatal("a restart the daemon does not allow must wait")
	}
	status.CanRestart = true
	status.PendingRestart = nil
	if _, ok := pendingRestart(status); ok {
		t.Fatal("without a pending restart there is nothing to acknowledge")
	}
}

func TestAppTokenDropsTheTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app-token"), []byte("tok-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if token := appToken(dir); token != "tok-1" {
		t.Fatalf("token %q", token)
	}
	if token := appToken(t.TempDir()); token != "" {
		t.Fatalf("a missing token reads as empty, got %q", token)
	}
}

func TestRsiStatusAndAckSpeakTheDaemonProtocol(t *testing.T) {
	var acked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-graph-app-token") != "tok-1" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/app/rsi/status":
			w.Write([]byte(`{"canRestart":true,"pendingRestart":{"id":"act-9"}}`))
		case "/api/app/rsi/restart-ack":
			payload := make([]byte, 256)
			read, _ := r.Body.Read(payload)
			if read > 0 && r.Method == "POST" {
				acked = "act-9"
				w.Write([]byte(`{"cleared":true}`))
				return
			}
			w.WriteHeader(http.StatusBadRequest)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	status, ok := fetchRsiStatus(server.URL, "tok-1")
	if !ok {
		t.Fatal("status must be readable")
	}
	id, pending := pendingRestart(status)
	if !pending || id != "act-9" {
		t.Fatalf("id %q pending=%v", id, pending)
	}
	if !ackRestart(server.URL, "tok-1", id) || acked != "act-9" {
		t.Fatalf("ack sent %q", acked)
	}
	if _, ok := fetchRsiStatus(server.URL, "wrong"); ok {
		t.Fatal("a wrong app token must not read the status")
	}
}
