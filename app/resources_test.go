package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var resourceFixtures = map[string]string{
	"/api/catalog": `{"capabilities":[
		{"id":"exa-web-search","kind":"mcp","version":"3.4.1","name":"Exa Web Search","status":"available"},
		{"id":"browser-use","kind":"mcp","version":"2026.9.17","name":"Browser Use","status":"available"},
		{"id":"pstack","kind":"skill","version":"local","name":"pstack","status":"available"},
		{"id":"principle-first-principles","kind":"skill","version":"local","status":"available"},
		{"id":"broken-prompt","kind":"prompt","version":"1","name":"Broken Prompt","status":"available","error":"manifest unreadable"}
	],"agentCombinations":[{"id":"reviewer","name":"Alice_reviewer","status":"valid"}],"agentCombinationFile":"/Users/macmini/.graph/agent-combinations.json"}`,
	"/api/capabilities/config": `{"items":[
		{"id":"browser-use","version":"2026.9.17","kind":"mcp","missing":["BROWSER_USE_API_KEY"],"ready":false},
		{"id":"pstack","version":"local","kind":"skill","missing":[],"ready":false,"error":"Cannot read capability.json"}
	]}`,
	"/api/settings": `{"capabilityRoot":"/Users/macmini/.graph/capabilities"}`,
	"/api/config":   `{"revision":428,"config":{"configured":true,"piExtensionAutoUpdate":false,"models":{"entries":[]}}}`,
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

func TestTheResourceLibraryCountsTheRealLibrary(t *testing.T) {
	rows, err := parseResourceLibrary([]byte(resourceFixtures["/api/catalog"]), []byte(resourceFixtures["/api/capabilities/config"]))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 {
		t.Fatalf("the library has every capability, got %d", len(rows))
	}
	if rows[0].kind != "mcp" || rows[0].name != "Browser Use" || rows[1].name != "Exa Web Search" {
		t.Fatalf("rows sort by kind then name, got %+v", rows)
	}
	if got := resourceSummary(rows); got != "3 / 5 可用 · 1 个待配置" {
		t.Fatalf("summary %q", got)
	}
	if resourceLabel(rows[0]) != "Browser Use · v2026.9.17 · 缺 BROWSER_USE_API_KEY" {
		t.Fatalf("label %q", resourceLabel(rows[0]))
	}
	if resourceLabel(rows[1]) != "Exa Web Search · v3.4.1" {
		t.Fatalf("a ready resource stays quiet, label %q", resourceLabel(rows[1]))
	}
	pstack := rows[4]
	if pstack.name != "pstack" || !pstack.ready {
		t.Fatalf("a plain skill is not broken by the old config noise, got %+v", pstack)
	}
	if brok := rows[2]; brok.ready || resourceLabel(brok) != "Broken Prompt · v1 · 加载失败：manifest unreadable" {
		t.Fatalf("a load error is shown as such, got %q", resourceLabel(brok))
	}
	lines := resourceRows(rows)
	if len(lines) != 8 || !lines[0].header || lines[0].kind != "mcp · 2" || !lines[3].header || lines[3].kind != "prompt · 1" || !lines[5].header || lines[5].kind != "skill · 2" {
		t.Fatalf("lines %+v", lines)
	}
}

func TestTheResourcePaneRendersTheRealLibrary(t *testing.T) {
	server := resourceServer(t)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	tester := ui.NewTester(state.view, 860, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, wanted := range []string{"资源库 · 3 / 5 可用 · 1 个待配置", "mcp · 2", "skill · 2", "prompt · 1",
		"Browser Use · v2026.9.17 · 缺 BROWSER_USE_API_KEY", "pstack · vlocal", "Broken Prompt · v1 · 加载失败：manifest unreadable"} {
		if !tester.HasText(wanted) {
			t.Fatalf("missing %q in texts %q", wanted, tester.Texts())
		}
	}
}

func TestShellOpensTheResourcePane(t *testing.T) {
	server := resourceServer(t)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.openModule("capabilities")
	if state.activeBoardKind() != "capabilities" || state.resources == nil {
		t.Fatalf("kind %q", state.activeBoardKind())
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.resources.status != "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("资源库 · 3 / 5 可用 · 1 个待配置") {
		t.Fatalf("the resource pane must render, texts %q", tester.Texts())
	}
}

func TestResourcePaneTogglesAutoUpdateAndOpensTheDirectory(t *testing.T) {
	posted := ""
	actions := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/config" {
			payload := make([]byte, 8192)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			actions["config"]++
			w.Write([]byte(`{"applied":true}`))
			return
		}
		body, ok := resourceFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	opened := ""
	state.openPath = func(path string) error {
		opened = path
		return nil
	}
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	if state.root != "/Users/macmini/.graph/capabilities" || state.revision != 428 || state.autoUpdate {
		t.Fatalf("state root %q revision %d autoUpdate %v", state.root, state.revision, state.autoUpdate)
	}
	tester := ui.NewTester(state.view, 860, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("扩展自动更新：关") || !tester.HasText("/Users/macmini/.graph/capabilities") {
		t.Fatalf("the pane must show the switch and the directory, texts %q", tester.Texts())
	}
	if err := tester.Click("打开能力目录"); err != nil {
		t.Fatalf("click 打开能力目录: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for opened == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if opened != "/Users/macmini/.graph/capabilities" {
		t.Fatalf("the button must open the capability root, opened %q", opened)
	}
	state.toggleAutoUpdate()
	if actions["config"] != 1 {
		t.Fatalf("the switch must write the config, actions %v", actions)
	}
	for _, wanted := range []string{`"expectedRevision":428`, `"piExtensionAutoUpdate":true`, `"models"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
}

func TestResourceSwitchReportsARejectedWrite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.WriteHeader(http.StatusConflict)
			return
		}
		body, ok := resourceFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.toggleAutoUpdate()
	if !strings.HasPrefix(state.status, "写入被拒绝：") || !contains(state.status, "重进资源页") {
		t.Fatalf("a rejected write must name the recovery, status %q", state.status)
	}
}
