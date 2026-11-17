package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const magpiePickerModelsFixture = `{"models":[
 {"id":"magpie/codex/gpt-6-astra","provider":"codex","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"magpie/codex/gpt-5-6-luna","provider":"codex","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"magpie/deepseek/deepseek-chat","provider":"deepseek","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"opencode-go:deepseek-v4.1-flash","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]}
]}`

const magpiePickerProvidersFixture = `{
 "available":true,
 "dir":"/Users/macmini/.config/magpie",
 "gateway":"127.0.0.1:3425",
 "models":{"codex":2,"deepseek":1},
 "providers":[
  {"id":"codex","label":"ChatGPT","badge":"套餐","keys":0,"configured":true,
   "accounts":[{"user":"a59@gmail.com","plan":"plus","on":true}],"quotas":[]},
  {"id":"deepseek","label":"DeepSeek","badge":"按量付费","chat":"https://api.deepseek.com/v1",
   "host":"api.deepseek.com","keys":2,"configured":true,"accounts":[],"quotas":[]}
 ]
}`

func magpiePickerServer(t *testing.T, mock *pickerMock) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/model") && r.Method == http.MethodPost:
			body := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(body)
			mock.mu.Lock()
			mock.selected = append(mock.selected, string(body))
			mock.mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/settings":
			_, _ = w.Write([]byte(magpiePickerModelsFixture))
		case r.URL.Path == "/api/providers/magpie":
			_, _ = w.Write([]byte(magpiePickerProvidersFixture))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestThePickerFiltersByTheMagpieProvider(t *testing.T) {
	mock := &pickerMock{}
	server := magpiePickerServer(t, mock)
	state := newChatState(server.URL, "")
	state.active = "c1"
	state.loadModels()
	state.modelPicker.open = true
	state.modelPicker.provider = "codex"

	models := state.pickerModels()
	if len(models) != 2 {
		t.Fatalf("filtering by a magpie provider is not empty, got %d %+v", len(models), models)
	}
	for _, model := range models {
		if !strings.HasPrefix(model.id, "magpie/codex/") {
			t.Fatalf("the filter keeps only codex models, got %+v", models)
		}
	}
	tester := frames(ui.NewTester(state.view, 900, 700))
	if !tester.HasText("gpt-6-astra") {
		t.Fatalf("the picker shows the provider's model, texts %q", tester.Texts())
	}
	if tester.HasText("deepseek-chat") {
		t.Fatalf("the picker hides other providers, texts %q", tester.Texts())
	}
}

func TestChoosingAMagpieModelSendsItsID(t *testing.T) {
	mock := &pickerMock{}
	server := magpiePickerServer(t, mock)
	state := newChatState(server.URL, "")
	state.active = "c1"
	state.loadModels()
	state.modelPicker.provider = "codex"
	models := state.pickerModels()
	if len(models) == 0 {
		t.Fatalf("the codex filter has models, got %+v", state.models)
	}
	state.chooseModel(models[0])
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mock.mu.Lock()
		done := len(mock.selected) > 0
		mock.mu.Unlock()
		if done {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mock.mu.Lock()
	selected := append([]string{}, mock.selected...)
	mock.mu.Unlock()
	if len(selected) == 0 {
		t.Fatalf("choosing a model posts it, status %q", state.status)
	}
	if !strings.Contains(selected[0], `"model":"magpie/codex/gpt-6-astra"`) {
		t.Fatalf("the request carries the magpie model id, got %s", selected[0])
	}
	if state.currentModel != "magpie/codex/gpt-6-astra" {
		t.Fatalf("the session remembers the magpie model, got %q", state.currentModel)
	}
}

func TestUsingAProviderOpensThePickerOnItsModels(t *testing.T) {
	mock := &pickerMock{}
	server := magpiePickerServer(t, mock)
	shell := newShellState(server.URL, "")
	shell.chat = newChatState(server.URL, "")
	shell.chat.active = "c1"
	shell.chat.loadModels()
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if err := tester.Click("用 ChatGPT 的模型"); err != nil {
		t.Fatalf("use the codex models: %v", err)
	}
	chat := shell.active()
	if chat == nil || chat.modelPicker.provider != "codex" || !chat.modelPicker.open {
		t.Fatalf("the row opens the picker on the provider, got %+v", chat)
	}
	models := chat.pickerModels()
	if len(models) != 2 {
		t.Fatalf("the picker lists the provider's models, got %d %+v", len(models), models)
	}
}

func TestRefreshingProvidersDropsTheStaleModelList(t *testing.T) {
	mock := &pickerMock{}
	server := magpiePickerServer(t, mock)
	shell := newShellState(server.URL, "")
	shell.chat = newChatState(server.URL, "")
	shell.chat.active = "c1"
	shell.chat.loadModels()
	shell.modelMeta = map[string]modelMeta{"stale": {id: "stale"}}
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	shell.chat.models = []modelChoice{{id: "magpie/codex/stale"}}
	shell.refreshProviders()
	providersFrameUntil(t, tester, func() bool { return !shell.providers.loading && len(shell.chat.models) == 0 })
	if len(shell.chat.models) != 0 {
		t.Fatalf("a provider refresh drops cached models, got %+v", shell.chat.models)
	}
	if shell.modelMeta != nil {
		t.Fatalf("a provider refresh drops cached model metadata, got %+v", shell.modelMeta)
	}
}
