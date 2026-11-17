package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const magpieSessionModelsFixture = `{"models":[
 {"id":"codex:codex/gpt-6.1-sol","provider":"codex","defaultThinkingLevel":"medium","thinkingOptions":[{"level":"low"},{"level":"medium"},{"level":"high"}]},
 {"id":"opencode-go:deepseek-v4.1-flash","provider":"opencode-go","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]}
]}`

const magpieSessionProvidersFixture = `{
 "available":true,
 "dir":"/Users/macmini/.config/magpie",
 "gateway":"127.0.0.1:3425",
 "models":{"codex":1},
 "providers":[
  {"id":"codex","label":"ChatGPT","badge":"套餐","keys":0,"configured":true,
   "accounts":[{"user":"a59@gmail.com","plan":"plus","on":true}],"quotas":[]}
 ]
}`

type magpieSessionMock struct {
	mu       sync.Mutex
	selected []string
}

func magpieSessionServer(t *testing.T, mock *magpieSessionMock) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/settings":
			_, _ = w.Write([]byte(magpieSessionModelsFixture))
		case r.URL.Path == "/api/providers/magpie":
			_, _ = w.Write([]byte(magpieSessionProvidersFixture))
		case strings.HasSuffix(r.URL.Path, "/model") && r.Method == http.MethodPost:
			body := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(body)
			mock.mu.Lock()
			mock.selected = append(mock.selected, string(body))
			mock.mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = w.Write([]byte(`{"messages":[],"hasOlder":false}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestAProviderRowLeadsToItsModelInTheSession(t *testing.T) {
	mock := &magpieSessionMock{}
	server := magpieSessionServer(t, mock)
	shell := newShellState(server.URL, "")
	shell.chat = newChatState(server.URL, "")
	shell.chat.active = "c1"
	shell.chat.providerOn = shell.providersEnabled
	shell.chat.loadModels()
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })

	if err := tester.Click("用 ChatGPT 的模型"); err != nil {
		t.Fatalf("use the ChatGPT models: %v", err)
	}
	frames(tester)
	chat := shell.active()
	if chat == nil || chat.modelPicker.provider != "codex" || !chat.modelPicker.open {
		t.Fatalf("the row opens the picker on that provider, got %+v", chat)
	}
	models := chat.pickerModels()
	if len(models) != 1 || models[0].id != "codex:codex/gpt-6.1-sol" {
		t.Fatalf("the picker is not empty for the provider, got %+v", models)
	}

	picker := frames(ui.NewTester(chat.view, 900, 700))
	if !picker.HasText("gpt-6.1-sol") {
		t.Fatalf("the picker shows the provider's model, texts %q", picker.Texts())
	}
	if err := picker.Click("gpt-6.1-sol"); err != nil {
		t.Fatalf("pick the magpie model: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mock.mu.Lock()
		selected := len(mock.selected)
		mock.mu.Unlock()
		if selected > 0 && chat.currentModel != "" {
			break
		}
		picker.Frame()
	}

	if chat.currentModel != "codex:codex/gpt-6.1-sol" || chat.currentThinking != "medium" {
		t.Fatalf("the session shows the picked model, got model %q thinking %q", chat.currentModel, chat.currentThinking)
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.selected) == 0 {
		t.Fatalf("picking the model sends it, status %q", chat.status)
	}
	if !strings.Contains(mock.selected[0], `"model":"codex:codex/gpt-6.1-sol"`) {
		t.Fatalf("the request carries the magpie model id, got %s", mock.selected[0])
	}
}

func TestRefreshingProvidersLoadsTheNewMagpieModelList(t *testing.T) {
	var refreshed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/settings":
			if refreshed.Load() {
				_, _ = w.Write([]byte(`{"models":[
				 {"id":"codex:codex/gpt-6.1-terra","provider":"codex","defaultThinkingLevel":"medium","thinkingOptions":[{"level":"low"},{"level":"medium"},{"level":"high"}]}
				]}`))
				return
			}
			_, _ = w.Write([]byte(magpieSessionModelsFixture))
		case r.URL.Path == "/api/providers/magpie":
			_, _ = w.Write([]byte(magpieSessionProvidersFixture))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.chat = newChatState(server.URL, "")
	shell.chat.active = "c1"
	shell.chat.providerOn = shell.providersEnabled
	shell.chat.loadModels()
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })

	refreshed.Store(true)
	shell.refreshProviders()
	providersFrameUntil(t, tester, func() bool { return !shell.providers.loading && len(shell.active().models) == 0 })

	chat := shell.active()
	chat.modelPicker.provider = "codex"
	chat.modelPicker.open = true
	picker := frames(ui.NewTester(chat.view, 900, 700))
	deadline := time.Now().Add(5 * time.Second)
	for !picker.HasText("gpt-6.1-terra") && time.Now().Before(deadline) {
		picker.Frame()
	}
	if !picker.HasText("gpt-6.1-terra") {
		t.Fatalf("a provider refresh reloads the model list, texts %q", picker.Texts())
	}
	if picker.HasText("gpt-6.1-sol") {
		t.Fatalf("the stale model is gone after the refresh, texts %q", picker.Texts())
	}
}
