package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func call(t *testing.T, server *httptest.Server, token, path string, body string) (int, map[string]any) {
	t.Helper()
	request, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("content-type", "application/json")
	if token != "" {
		request.Header.Set(shellHeader, token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	parsed := map[string]any{}
	_ = json.Unmarshal(payload, &parsed)
	return response.StatusCode, parsed
}

func TestBridgeRefusesCallersWithoutTheToken(t *testing.T) {
	api := &shellAPI{secrets: filepath.Join(t.TempDir(), "secrets.json")}
	server := httptest.NewServer(api.handler("secret-token"))
	defer server.Close()
	if status, _ := call(t, server, "wrong", "/secret-status", `{"refs":[]}`); status != http.StatusForbidden {
		t.Fatalf("a wrong token answered %d", status)
	}
	if status, _ := call(t, server, "", "/secret-status", `{"refs":[]}`); status != http.StatusForbidden {
		t.Fatalf("a missing token answered %d", status)
	}
}

func TestBridgeStoresAKeyAndReportsItConfigured(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.json")
	api := &shellAPI{secrets: path}
	server := httptest.NewServer(api.handler("token"))
	defer server.Close()

	status, saved := call(t, server, "token", "/save-secret", `{"ref":"GRAPH_OPENAI_KEY","value":"sk-live"}`)
	if status != http.StatusOK || saved["stored"] != true {
		t.Fatalf("save answered %d %v", status, saved)
	}
	_, reported := call(t, server, "token", "/secret-status", `{"refs":["GRAPH_OPENAI_KEY","GRAPH_MISSING_KEY"]}`)
	if reported["GRAPH_OPENAI_KEY"] != true || reported["GRAPH_MISSING_KEY"] != false {
		t.Fatalf("status %v", reported)
	}
	if values := secretValues(path); values["GRAPH_OPENAI_KEY"] != "sk-live" {
		t.Fatalf("stored value %q", values["GRAPH_OPENAI_KEY"])
	}
	_, revoked := call(t, server, "token", "/save-secret", `{"ref":"GRAPH_OPENAI_KEY","value":null}`)
	if revoked["stored"] != true {
		t.Fatalf("revoke answered %v", revoked)
	}
	if _, present := secretValues(path)["GRAPH_OPENAI_KEY"]; present {
		t.Fatal("a revoked ref must leave the file")
	}
}

func TestBridgeOpensResourcesAndPicksDirectories(t *testing.T) {
	api := &shellAPI{
		secrets: filepath.Join(t.TempDir(), "secrets.json"),
		pick:    func() (string, error) { return "/Users/me/project", nil },
		open: func(kind string) (string, error) {
			directory, err := resourceDirectory("/Users/me/.graph", kind)
			return directory, err
		},
	}
	server := httptest.NewServer(api.handler("token"))
	defer server.Close()

	_, picked := call(t, server, "token", "/pick-directory", `{}`)
	if picked["path"] != "/Users/me/project" {
		t.Fatalf("pick answered %v", picked)
	}
	_, opened := call(t, server, "token", "/open-resource", `{"kind":"skills"}`)
	if opened["opened"] != true || opened["path"] != "/Users/me/.graph/capabilities/skills" {
		t.Fatalf("open answered %v", opened)
	}
	_, unknown := call(t, server, "token", "/open-resource", `{"kind":"nope"}`)
	if unknown["opened"] != false {
		t.Fatalf("an unknown library answered %v", unknown)
	}
}

func TestBridgeIsReachableFromTheConsoleOriginOnly(t *testing.T) {
	api := &shellAPI{secrets: filepath.Join(t.TempDir(), "secrets.json")}
	server := httptest.NewServer(api.handler("token"))
	defer server.Close()
	request, _ := http.NewRequest("OPTIONS", server.URL+"/secret-status", nil)
	request.Header.Set("Origin", "http://127.0.0.1:65146")
	request.Header.Set("Access-Control-Request-Headers", shellHeader)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight answered %d", response.StatusCode)
	}
	if origin := response.Header.Get("Access-Control-Allow-Origin"); origin != "http://127.0.0.1:65146" {
		t.Fatalf("allow-origin %q", origin)
	}
}

func TestPreloadScriptGainsTheTokenAndAddress(t *testing.T) {
	source := readPreload(t)
	rendered := preloadScript(source, "tok", "http://127.0.0.1:5555")
	if strings.Contains(rendered, "__GRAPH_SHELL_") {
		t.Fatal("the placeholders must be replaced")
	}
	if !strings.Contains(rendered, "tok") || !strings.Contains(rendered, "http://127.0.0.1:5555") {
		t.Fatal("the preload script must carry the token and the bridge address")
	}
	if !strings.Contains(rendered, "isDesktop: true") {
		t.Fatal("the preload script must mark the page as the desktop shell")
	}
}

func readPreload(t *testing.T) string {
	t.Helper()
	payload, err := os.ReadFile("preload.js")
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}
