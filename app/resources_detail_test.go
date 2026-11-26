package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

var detailFixtures = map[string]string{
	"/api/catalog": `{"capabilities":[
		{"id":"browser-use","kind":"mcp","version":"2026.9.17","name":"Browser Use","status":"available","source":"/Users/macmini/.graph/capabilities/mcp/browser-use","snapshot":{"manifest":{"description":"Browser automation server.","source":"https://github.com/example/browser-use"}}},
		{"id":"pstack","kind":"skill","version":"local","name":"pstack","status":"available","origin":"agent","source":"/Users/macmini/.graph/agents/main/skills/pstack","snapshot":{"path":"/Users/macmini/.graph/agents/main/skills/pstack"}}
	],"agentCombinationFile":"/Users/macmini/.graph/agent-combinations.json"}`,
	"/api/capabilities/config": `{"items":[
		{"id":"browser-use","version":"2026.9.17","kind":"mcp","fields":[{"env":"BROWSER_USE_API_KEY","label":"Browser Use Api Key","secret":true,"reason":"请求头 x-browser-use-api-key"},{"env":"BROWSER_USE_BASE_URL","label":"Browser Use Base Url","secret":false,"reason":"环境变量 BROWSER_USE_BASE_URL"}],"configured":[],"missing":["BROWSER_USE_API_KEY"],"ready":false}
	]}`,
	"/api/settings": `{"capabilityRoot":"/Users/macmini/.graph/capabilities"}`,
}

func detailServer(t *testing.T, actions map[string]int, posted *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/app/secret" {
			payload := make([]byte, 8192)
			read, _ := r.Body.Read(payload)
			if posted != nil {
				*posted = append(*posted, string(payload[:read]))
			}
			if actions != nil {
				actions["secret"]++
			}
			w.Write([]byte(`{"applied":true}`))
			return
		}
		body, ok := detailFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func TestTheResourceDetailListsItsFieldsAndPath(t *testing.T) {
	server := detailServer(t, nil, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.selectResource("browser-use")
	tester := newTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, want := range []string{"Browser Use", "MCP 服务器", "v2026.9.17", "/Users/macmini/.graph/capabilities/mcp/browser-use",
		"Browser automation server.", "example/browser-use",
		"BROWSER_USE_API_KEY", "请求头 x-browser-use-api-key", "BROWSER_USE_BASE_URL", "缺少"} {
		if !tester.HasText(want) {
			t.Fatalf("the detail misses %q, texts %q", want, tester.Texts())
		}
	}
}

func TestWritingAFieldSecretClosesTheLoop(t *testing.T) {
	posted := []string{}
	server := detailServer(t, nil, &posted)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.openPath = func(string) error { return nil }
	state.load()
	state.selectResource("browser-use")
	state.secretsPath = filepath.Join(t.TempDir(), "secrets.json")
	state.draftEnv = "BROWSER_USE_API_KEY"
	state.draftValue = "sk-live-browser"
	state.saveEnv()

	if len(posted) != 1 {
		t.Fatalf("saving a field posts one secret, posted %v (%q)", posted, state.status)
	}
	if values := secretValues(state.secretsPath); values["BROWSER_USE_API_KEY"] != "sk-live-browser" {
		t.Fatalf("the desktop keeps the value it confirmed, saved %v", values)
	}
	for _, want := range []string{`"ref":"BROWSER_USE_API_KEY"`, `"value":"sk-live-browser"`, `"persisted":true`} {
		if !strings.Contains(posted[0], want) {
			t.Fatalf("the pushed secret carries %q, body %s", want, posted[0])
		}
	}
	if len(state.saved) != 1 || state.saved["BROWSER_USE_API_KEY"] != "sk-live-browser" {
		t.Fatalf("what the daemon accepted is remembered, saved %v", state.saved)
	}
	if state.status != "" {
		t.Fatalf("a successful save clears the status, got %q", state.status)
	}
}

func TestAnEmptyFieldValueIsRefusedBeforeAnyWrite(t *testing.T) {
	posted := []string{}
	server := detailServer(t, nil, &posted)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.selectResource("browser-use")
	state.draftEnv = "BROWSER_USE_API_KEY"
	state.draftValue = "   "
	state.saveEnv()
	if len(posted) != 0 {
		t.Fatalf("an empty value is never sent, posted %v", posted)
	}
	if state.status == "" {
		t.Fatal("an empty value says why it was not saved")
	}
}

func TestARejectedSecretIsReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/app/secret" {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"code":"invalid_input","message":"broken"}`))
			return
		}
		body, ok := detailFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.selectResource("browser-use")
	state.draftEnv = "BROWSER_USE_API_KEY"
	state.draftValue = "sk-broken"
	state.saveEnv()
	if !strings.HasPrefix(state.status, "保存失败：") {
		t.Fatalf("a rejected save is reported, status %q", state.status)
	}
	if len(state.saved) != 0 {
		t.Fatalf("nothing is remembered when the daemon refused, saved %v", state.saved)
	}
}

func TestRevokingAFieldClearsBothSides(t *testing.T) {
	posted := []string{}
	server := detailServer(t, nil, &posted)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.secretsPath = filepath.Join(t.TempDir(), "secrets.json")
	state.load()
	if err := saveSecret(state.secretsPath, "BROWSER_USE_API_KEY", stringPointer("sk-old")); err != nil {
		t.Fatalf("seed the stored secret: %v", err)
	}
	state.saved = map[string]string{"BROWSER_USE_API_KEY": "sk-old"}
	state.selectResource("browser-use")
	state.revokeEnv("BROWSER_USE_API_KEY")

	if len(posted) != 1 {
		t.Fatalf("revoking posts once, posted %v (%q)", posted, state.status)
	}
	for _, want := range []string{`"ref":"BROWSER_USE_API_KEY"`, `"value":null`} {
		if !strings.Contains(posted[0], want) {
			t.Fatalf("the revoke carries %q, body %s", want, posted[0])
		}
	}
	if values := secretValues(state.secretsPath); values["BROWSER_USE_API_KEY"] != "" {
		t.Fatalf("the local copy goes too, saved %v", values)
	}
	if _, kept := state.saved["BROWSER_USE_API_KEY"]; kept {
		t.Fatalf("the page forgets it as well, saved %v", state.saved)
	}
}

func stringPointer(value string) *string { return &value }

func TestAFieldTheDaemonReportsConfiguredShowsFilled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/catalog":
			w.Write([]byte(`{"capabilities":[{"id":"browser-use","kind":"mcp","version":"1","name":"Browser Use","status":"available","source":"/tmp/browser-use"}]}`))
		case "/api/capabilities/config":
			w.Write([]byte(`{"items":[{"id":"browser-use","version":"1","kind":"mcp","fields":[{"env":"BROWSER_USE_API_KEY","label":"Key","secret":true}],"configured":["BROWSER_USE_API_KEY"],"missing":[],"ready":true}]}`))
		case "/api/settings":
			w.Write([]byte(`{"capabilityRoot":"/tmp/capabilities"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.selectResource("browser-use")
	tester := newTester(state.view, 900, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("已填写") {
		t.Fatalf("a configured field reads as filled, texts %q", tester.Texts())
	}
	if !tester.HasText("撤销") {
		t.Fatalf("a filled field can be revoked, texts %q", tester.Texts())
	}
}

func TestClosingTheDetailReturnsToTheLibrary(t *testing.T) {
	server := detailServer(t, nil, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.selectResource("browser-use")
	tester := newTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if err := tester.Click("关闭资源详情"); err != nil {
		t.Fatalf("close the detail: %v", err)
	}
	frames(tester)
	if state.selected != "" {
		t.Fatalf("closing clears the selection, got %q", state.selected)
	}
	if !tester.HasText("发现") {
		t.Fatalf("the library is back, texts %q", tester.Texts())
	}
}

func TestClickingARowOpensItsDetail(t *testing.T) {
	server := detailServer(t, nil, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	tester := newTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if err := tester.Click("资源 Browser Use"); err != nil {
		t.Fatalf("open a library card: %v", err)
	}
	frames(tester)
	if state.selected != "browser-use" {
		t.Fatalf("the card selects its resource, got %q", state.selected)
	}
	if !tester.HasText("关闭资源详情") {
		t.Fatalf("the detail shows, texts %q", tester.Texts())
	}
}

func TestSavingAFieldCarriesTheAppBridgeToken(t *testing.T) {
	posted := []string{}
	tokens := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/app/secret" {
			payload := make([]byte, 8192)
			read, _ := r.Body.Read(payload)
			posted = append(posted, string(payload[:read]))
			tokens = append(tokens, r.Header.Get("x-graph-app-token"))
			if r.Header.Get("x-graph-app-token") == "" {
				w.WriteHeader(http.StatusForbidden)
				w.Write([]byte(`{"code":"forbidden","message":"App bridge token required"}`))
				return
			}
			w.Write([]byte(`{"applied":true}`))
			return
		}
		body, ok := detailFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.appToken = "app-bridge-token"
	state.secretsPath = filepath.Join(t.TempDir(), "secrets.json")
	state.load()
	state.selectResource("browser-use")
	state.draftEnv = "BROWSER_USE_API_KEY"
	state.draftValue = "sk-with-token"
	state.saveEnv()

	if len(tokens) != 1 || tokens[0] != "app-bridge-token" {
		t.Fatalf("the app bridge token rides along, tokens %v (%q, posted %v)", tokens, state.status, posted)
	}
	if state.status != "" {
		t.Fatalf("the save succeeds with the token, status %q", state.status)
	}
	if values := secretValues(state.secretsPath); values["BROWSER_USE_API_KEY"] != "sk-with-token" {
		t.Fatalf("the value is kept locally, saved %v", values)
	}
}
