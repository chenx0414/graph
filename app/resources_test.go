package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var resourceFixtures = map[string]string{
	"/api/capabilities/config": `{"items":[
		{"id":"browser-use","name":"Browser Use","kind":"mcp","version":"2026.9.17","missing":["BROWSER_USE_API_KEY"],"ready":false},
		{"id":"browserbase","name":"Browserbase","kind":"mcp","version":"2.4.3","missing":["BROWSERBASE_API_KEY","BROWSERBASE_PROJECT_ID"],"ready":false},
		{"id":"agent-browser-native","name":"","kind":"skill","version":"0.6.17","missing":[],"ready":true}
	]}`,
}

func resourceServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := resourceFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func TestResourceCatalogSortsAndLabels(t *testing.T) {
	rows, err := parseResources([]byte(resourceFixtures["/api/capabilities/config"]))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0].kind != "mcp" || rows[2].kind != "skill" {
		t.Fatalf("rows must be grouped by kind, got %+v", rows)
	}
	if rows[0].name != "Browser Use" || rows[1].name != "Browserbase" {
		t.Fatalf("rows must sort by name inside a kind, got %+v", rows)
	}
	if resourceLabel(rows[0]) != "Browser Use · v2026.9.17 · 缺 BROWSER_USE_API_KEY" {
		t.Fatalf("label %q", resourceLabel(rows[0]))
	}
	if resourceLabel(rows[1]) != "Browserbase · v2.4.3 · 缺 BROWSERBASE_API_KEY、BROWSERBASE_PROJECT_ID" {
		t.Fatalf("label %q", resourceLabel(rows[1]))
	}
	if resourceLabel(rows[2]) != "agent-browser-native · v0.6.17 · 就绪" {
		t.Fatalf("an item without a name falls back to its id, got %q", resourceLabel(rows[2]))
	}
	if resourceSummary(rows) != "1 / 3 就绪" {
		t.Fatalf("summary %q", resourceSummary(rows))
	}
	lines := resourceRows(rows)
	if len(lines) != 5 || !lines[0].header || lines[0].kind != "mcp" || lines[1].header || !lines[3].header || lines[3].kind != "skill" || lines[4].row.name != "agent-browser-native" {
		t.Fatalf("lines %+v", lines)
	}
}

func TestResourcePaneRendersEveryCapability(t *testing.T) {
	server := resourceServer(t)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	tester := ui.NewTester(state.view, 820, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, wanted := range []string{"资源", "能力库 · 1 / 3 就绪", "mcp", "skill", "Browser Use · v2026.9.17 · 缺 BROWSER_USE_API_KEY", "agent-browser-native · v0.6.17 · 就绪"} {
		if !tester.HasText(wanted) {
			t.Fatalf("missing %q in texts %q", wanted, tester.Texts())
		}
	}
}

func TestShellOpensTheResourcePane(t *testing.T) {
	server := resourceServer(t)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.openResources()
	if state.section != "resources" || state.resources == nil {
		t.Fatalf("section %q", state.section)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.resources.status != "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("能力库 · 1 / 3 就绪") {
		t.Fatalf("the resource pane must render, texts %q", tester.Texts())
	}
}
