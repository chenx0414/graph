package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

const providersPayloadFixture = `{
 "platforms":[
  {"id":"opencode-go","label":"OpenCode Go","api":"openai-completions","baseUrl":"https://opencode.ai/zen/go/v1","credentialKind":"subscription","credentialConfigured":true,"modelsListSupported":true,"custom":false},
  {"id":"deepseek","label":"DeepSeek","api":"openai-completions","baseUrl":"https://api.deepseek.com/v1","credentialKind":"apiKey","credentialConfigured":false,"modelsListSupported":false,"custom":false},
  {"id":"self-host","label":"自建网关","api":"anthropic-messages","baseUrl":"http://127.0.0.1:3425/v1","credentialKind":"apiKey","credentialConfigured":true,"modelsListSupported":true,"custom":true}
 ],
 "credentials":{
  "opencode-go":{"secretRef":"GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY","resolved":true,"displayName":"opencode-go-小宝宝"}
 }
}`

const providersModelsFixture = `{"models":[
 {"id":"opencode-go:deepseek-v4.1-flash","defaultThinkingLevel":"max","thinkingOptions":[{"level":"low"},{"level":"high"},{"level":"max"}]},
 {"id":"self-host:qwen-3-coder","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]}
]}`

func providersFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers":
			_, _ = w.Write([]byte(providersPayloadFixture))
		case "/api/settings":
			_, _ = w.Write([]byte(providersModelsFixture))
		case "/api/conversations":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTheProvidersPageListsTheRealProviders(t *testing.T) {
	server := providersFixtureServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if len(shell.providers.entries) != 3 {
		t.Fatalf("the page lists every platform, got %d (%q)", len(shell.providers.entries), shell.providers.failed)
	}
	for _, want := range []string{"模型", "供应商", "OpenCode Go", "DeepSeek", "自建网关", "套餐", "按量付费", "自建", "已连接", "未配置"} {
		if !tester.HasText(want) {
			t.Fatalf("the providers page shows %q, texts %q", want, tester.Texts())
		}
	}
	if !tester.HasText("opencode.ai") || !tester.HasText("1 个模型") {
		t.Fatalf("a row explains the endpoint and its model count, texts %q", tester.Texts())
	}
}

func TestAProviderToggleFeedsTheModelPicker(t *testing.T) {
	server := providersFixtureServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if !shell.providersEnabled("opencode-go") {
		t.Fatalf("a configured provider starts enabled")
	}
	if err := tester.Click("停用 OpenCode Go"); err != nil {
		t.Fatalf("toggle the provider: %v", err)
	}
	tester = frames(tester)
	if shell.providersEnabled("opencode-go") {
		t.Fatalf("the toggle turns the provider off")
	}
	if !tester.HasText("未启用") {
		t.Fatalf("the row says it is off, texts %q", tester.Texts())
	}
}

func TestClickingAProviderOpensItsModels(t *testing.T) {
	server := providersFixtureServer(t)
	shell := newShellState(server.URL, "")
	chat := newChatState(server.URL, "")
	chat.active = "c1"
	chat.loadModels()
	chat.providerOn = shell.providersEnabled
	shell.chat = chat
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if err := tester.Click("用 OpenCode Go 的模型"); err != nil {
		t.Fatalf("open the provider's models: %v", err)
	}
	frames(tester)
	if !chat.modelPicker.open || chat.modelPicker.provider != "opencode-go" {
		t.Fatalf("the row opens the picker on that provider, got %+v", chat.modelPicker)
	}
}

func TestTheProviderRowsUseTheRealBrandIcons(t *testing.T) {
	for _, id := range []string{"opencode-go", "command-goat", "deepseek", "chatgpt", "anthropic", "google-gemini", "openai", "openrouter", "grok"} {
		if providerBrandIcon(id) == nil {
			t.Fatalf("the provider %q has its brand icon", id)
		}
	}
	if providerBrandIcon("self-host") != nil {
		t.Fatalf("a custom provider falls back to a letter tile, not a brand icon")
	}
}
