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

type restartDaemon struct {
	restarts int
	reloads  []bool
	apply    func()
}

func (d *restartDaemon) start() error { return nil }

func (d *restartDaemon) adopt(int) {}

func (d *restartDaemon) refresh() daemonRefresh { return daemonRefresh{} }

func (d *restartDaemon) status() daemonStatus {
	return daemonStatus{Phase: daemonOwned}
}

func (d *restartDaemon) restart(reload bool) (bool, string) {
	d.reloads = append(d.reloads, reload)
	d.restarts++
	if d.apply != nil {
		d.apply()
	}
	return true, ""
}

func TestPollRsiAcksWithTheAddressAndTokenTheRestartedDaemonWrote(t *testing.T) {
	stateDir := t.TempDir()
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/app/rsi/status" || r.Header.Get("x-graph-app-token") != "old-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"canRestart":true,"pendingRestart":{"id":"act-1"}}`))
	}))
	defer old.Close()
	fresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/app/rsi/restart-ack" || r.Method != http.MethodPost || r.Header.Get("x-graph-app-token") != "fresh-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"cleared":true}`))
	}))
	defer fresh.Close()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(stateDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("console.json", `{"url":"`+old.URL+`","pid":1}`)
	write("app-token", "old-token\n")
	daemon := &restartDaemon{apply: func() {
		write("console.json", `{"url":"`+fresh.URL+`","pid":2}`)
		write("app-token", "fresh-token\n")
	}}
	s := &shell{paths: Paths{StateDir: stateDir}, daemon: daemon, console: old.URL}
	s.pollRsi()
	if daemon.restarts != 1 {
		t.Fatalf("the pending reload ran %d restarts", daemon.restarts)
	}
	if s.console != fresh.URL {
		t.Fatalf("the shell kept talking to %q", s.console)
	}
	s.pollRsi()
	if daemon.restarts != 1 {
		t.Fatalf("a request that was already handled was restarted again (%d)", daemon.restarts)
	}
}
