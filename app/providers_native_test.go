package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const nativeProvidersConfig = `{"revision":3,"config":{
 "configured":true,
 "models":{"entries":[
  {"id":"deepseek-v4-flash","provider":"opencode-go","api":"openai-completions","baseUrl":"https://opencode.ai/zen/go/v1",
   "contextWindow":131072,"maxTokens":8192,"credentialId":"opencode-go"},
  {"id":"deepseek-v4-pro","provider":"opencode-go","api":"openai-completions","baseUrl":"https://opencode.ai/zen/go/v1",
   "contextWindow":131072,"maxTokens":8192,"credentialId":"opencode-go"}
 ]},
 "credentials":{"opencode-go":{"secretRef":"OPENCODE_GO_API_KEY","configured":true}},
 "limits":{"credentials":{},"sharedGroups":{}},
 "piExtensionAutoUpdate":false
}}`

const nativeProvidersCatalog = `{"platforms":[
 {"id":"openai","label":"OpenAI","api":"openai-completions","baseUrl":"https://api.openai.com/v1",
  "credentialRef":"OPENAI_API_KEY","credentialKind":"api-key","modelsListSupported":true,"notes":[]},
 {"id":"custom","label":"自定义兼容平台 / 本地服务","api":"openai-completions","baseUrl":"",
  "credentialRef":"GRAPH_LOCAL_KEY","credentialKind":"api-key","modelsListSupported":true,"custom":true,"notes":[]}
],"credentials":{"opencode-go":{"secretRef":"OPENCODE_GO_API_KEY","resolved":true}}}`

type nativeProviderServer struct {
	mu        sync.Mutex
	config    string
	catalog   string
	magpie    string
	posted    []string
	secrets   []string
	revisions []string
}

func (stub *nativeProviderServer) postedCount() int {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return len(stub.posted)
}

func (stub *nativeProviderServer) snapshot() ([]string, []string) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return append([]string(nil), stub.posted...), append([]string(nil), stub.secrets...)
}

func newNativeProviderServer(t *testing.T, stub *nativeProviderServer) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/config":
			if r.Method == http.MethodPost {
				body := make([]byte, 65536)
				read, _ := r.Body.Read(body)
				stub.mu.Lock()
				stub.posted = append(stub.posted, string(body[:read]))
				stub.mu.Unlock()
				w.Write([]byte(`{"applied":true,"revision":4}`))
				return
			}
			if stub.config == "" {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte(stub.config))
		case "/api/providers":
			w.Write([]byte(stub.catalog))
		case "/api/app/secret":
			body := make([]byte, 8192)
			read, _ := r.Body.Read(body)
			stub.mu.Lock()
			stub.secrets = append(stub.secrets, string(body[:read]))
			stub.mu.Unlock()
			w.Write([]byte(`{"applied":true}`))
		case "/api/providers/magpie":
			if stub.magpie == "" {
				w.Write([]byte(`{"available":false,"error":"没有 Magpie","providers":[]}`))
				return
			}
			w.Write([]byte(stub.magpie))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTheProvidersPageWorksWithoutMagpie(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && len(shell.providers.native) == 0; attempt++ {
		render(tester)
	}
	if len(shell.providers.native) != 1 {
		t.Fatalf("the native provider list comes from the config, got %d (%q)", len(shell.providers.native), shell.providers.failed)
	}
	for _, want := range []string{"本机供应商", "opencode-go", "2 个模型", "已配置"} {
		if !tester.HasText(want) {
			t.Fatalf("the page shows %q without magpie, texts %q", want, tester.Texts())
		}
	}
	if tester.HasText("读不到供应商") {
		t.Fatalf("a missing magpie does not break the page, texts %q", tester.Texts())
	}
}

func TestAddingAProviderWritesTheConfigAndTheSecret(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && len(shell.providers.native) == 0; attempt++ {
		render(tester)
	}
	if err := tester.Click("添加供应商"); err != nil {
		t.Fatalf("open the add form: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("平台") {
		t.Fatalf("the form asks for a platform, texts %q", tester.Texts())
	}
	for _, field := range []string{"供应商名称", "接口地址", "API Key", "模型列表"} {
		if _, ok := tester.Access(field); !ok {
			t.Fatalf("the form has a %q field, texts %q", field, tester.Texts())
		}
	}
	tester.Type("")
	if err := tester.Click("供应商名称"); err != nil {
		t.Fatalf("focus the name: %v", err)
	}
	tester.Type("my-openai")
	if err := tester.Click("接口地址"); err != nil {
		t.Fatalf("focus the base url: %v", err)
	}
	tester.Type("https://api.openai.com/v1")
	if err := tester.Click("API Key"); err != nil {
		t.Fatalf("focus the key: %v", err)
	}
	tester.Type("sk-test-123")
	if err := tester.Click("模型列表"); err != nil {
		t.Fatalf("focus the models: %v", err)
	}
	tester.Type("gpt-4o, gpt-4o-mini")
	if err := tester.Click("保存供应商"); err != nil {
		t.Fatalf("save: %v", err)
	}
	for attempt := 0; attempt < 80 && stub.postedCount() == 0; attempt++ {
		render(tester)
	}
	if stub.postedCount() == 0 {
		t.Fatalf("the save never wrote the config")
	}
	posted := stub.posted[stub.postedCount()-1]
	for _, want := range []string{"my-openai", "gpt-4o", "gpt-4o-mini", "https://api.openai.com/v1"} {
		if !strings.Contains(posted, want) {
			t.Fatalf("the config carries %q, posted %s", want, posted)
		}
	}
	_, secrets := stub.snapshot()
	if len(secrets) == 0 || !strings.Contains(secrets[len(secrets)-1], "sk-test-123") {
		t.Fatalf("the api key is pushed as a secret, got %v", secrets)
	}
}

func TestMagpieStaysAnOptionalExtension(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog, magpie: magpieProvidersFixture}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && (len(shell.providers.native) == 0 || len(shell.providers.entries) == 0); attempt++ {
		render(tester)
	}
	if !tester.HasText("本机供应商") {
		t.Fatalf("the page keeps its own providers, texts %q", tester.Texts())
	}
	if !tester.HasText("Magpie（扩展）") {
		t.Fatalf("magpie is offered as an extension, texts %q", tester.Texts())
	}
	if !tester.HasText("直接出现在模型选择器里") {
		t.Fatalf("the page says magpie's models come through automatically, texts %q", tester.Texts())
	}
}

func TestClickingANativeProviderOpensItsEditor(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && len(shell.providers.native) == 0; attempt++ {
		render(tester)
	}
	if err := tester.Click("编辑 opencode-go"); err != nil {
		t.Fatalf("open the provider editor: %v", err)
	}
	tester = frames(tester)
	if shell.providers.editing != "opencode-go" {
		t.Fatalf("the row opens that provider's editor, editing %q", shell.providers.editing)
	}
	if !tester.HasText("编辑 opencode-go") || !tester.HasText("移除供应商") {
		t.Fatalf("the editor names the provider and offers removal, texts %q", tester.Texts())
	}
}

func TestRemovingANativeProviderDropsItFromTheConfig(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && len(shell.providers.native) == 0; attempt++ {
		render(tester)
	}
	if err := tester.Click("编辑 opencode-go"); err != nil {
		t.Fatalf("open the provider editor: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("移除供应商"); err != nil {
		t.Fatalf("arm the removal: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("确认移除"); err != nil {
		t.Fatalf("confirm the removal: %v", err)
	}
	for attempt := 0; attempt < 80 && stub.postedCount() == 0; attempt++ {
		render(tester)
	}
	if stub.postedCount() == 0 {
		t.Fatalf("the removal never wrote the config")
	}
	posted := stub.posted[stub.postedCount()-1]
	if strings.Contains(posted, "opencode-go") {
		t.Fatalf("the removed provider is gone from the config, posted %s", posted)
	}
}

func TestTheProviderRowOffersItsModelsWithoutOpeningTheEditor(t *testing.T) {
	stub := &nativeProviderServer{config: nativeProvidersConfig, catalog: nativeProvidersCatalog}
	server := newNativeProviderServer(t, stub)
	shell := newShellState(server.URL, "")
	chat := newChatState(server.URL, "")
	chat.active = "c1"
	shell.chat = chat
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	for attempt := 0; attempt < 40 && len(shell.providers.native) == 0; attempt++ {
		render(tester)
	}
	if err := tester.Click("用 opencode-go 的模型"); err != nil {
		t.Fatalf("open the provider's models: %v", err)
	}
	frames(tester)
	if !chat.modelPicker.open || chat.modelPicker.provider != "opencode-go" {
		t.Fatalf("the row action opens the picker on that provider, got %+v", chat.modelPicker)
	}
	if shell.providers.editing != "" {
		t.Fatalf("the model action does not open the editor, editing %q", shell.providers.editing)
	}
}
