package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadConsoleAdoptsTheRunningDaemon(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{StateDir: dir}
	if _, ok := paths.ReadConsole(); ok {
		t.Fatal("a state dir without console.json must not report a daemon")
	}
	writeFile(t, filepath.Join(dir, "console.json"), `{"url":"http://127.0.0.1:65146","pid":42,"mode":"execute"}`)
	info, ok := paths.ReadConsole()
	if !ok || info.URL != "http://127.0.0.1:65146" {
		t.Fatalf("adopted %q (ok=%v)", info.URL, ok)
	}
	writeFile(t, filepath.Join(dir, "console.json"), `{"pid":42}`)
	if _, ok := paths.ReadConsole(); ok {
		t.Fatal("a console.json without a url must be ignored")
	}
}

func TestSessionTokenDropsTheTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "session-token"), "abc123\n")
	if token := (Paths{StateDir: dir}).SessionToken(); token != "abc123" {
		t.Fatalf("token %q keeps a newline the http client refuses", token)
	}
}

func TestReachableChecksTheConsoleApiWithTheSessionCookie(t *testing.T) {
	var gotCookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie = r.Header.Get("Cookie")
		if r.URL.Path != "/api/conversations" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "session-token"), "abc123\n")
	paths := Paths{StateDir: dir}
	if !paths.Reachable(server.URL) {
		t.Fatal("a live console must be reachable")
	}
	if gotCookie != "graph_session=abc123" {
		t.Fatalf("Cookie %q", gotCookie)
	}
	if paths.Reachable(server.URL + "/nowhere") {
		t.Fatal("a console answering 404 for the API must not be adopted")
	}
	if paths.Reachable("") || paths.Reachable("::::") {
		t.Fatal("an empty or malformed address is not reachable")
	}
}

func TestDaemonArgsCarryThePathsTheConsoleNeeds(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{StateDir: dir, GraphHome: "/tmp/home", WebDir: "/tmp/web", SourceRoot: "/tmp/root", ConfigPath: filepath.Join(dir, "graph.config.json")}
	joined := strings.Join(paths.DaemonArgs(), " ")
	for _, wanted := range []string{"--state-dir " + dir, "--graph-home /tmp/home", "--web-dir /tmp/web", "--port 0", "--execute", "--dynamic", "--application-root /tmp/root"} {
		if !strings.Contains(joined, wanted) {
			t.Fatalf("args %q miss %q", joined, wanted)
		}
	}
	if strings.Contains(joined, "--config") {
		t.Fatal("a missing config file must not be passed to the daemon")
	}
	writeFile(t, paths.ConfigPath, "{}")
	if !strings.Contains(strings.Join(paths.DaemonArgs(), " "), "--config "+paths.ConfigPath) {
		t.Fatal("an existing config file must be passed to the daemon")
	}
}
