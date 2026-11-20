package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

func emptyModelShell(t *testing.T) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/settings":
			_, _ = w.Write([]byte(`{"models":[],"defaultModel":null,"projects":[]}`))
		case "/api/conversations":
			_, _ = w.Write([]byte(`[{"id":"g1","title":"Main","role":"global","archivedAt":null}]`))
		case "/api/conversations/g1":
			_, _ = w.Write([]byte(`{"id":"g1","messages":[],"telemetry":{"thinkingLevel":"off"}}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	chat := newChatState(server.URL, "tok")
	chat.active = "g1"
	state := newShellState(server.URL, "tok")
	state.chat = chat
	state.activeID = "g1"
	return state
}

func TestAMachineWithoutModelsSaysSoInsteadOfShowingOff(t *testing.T) {
	state := emptyModelShell(t)
	state.chat.syncModelTelemetry([]byte(`{"telemetry":{"thinkingLevel":"off"}}`))
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if tester.HasText("off") {
		t.Fatalf("an unconfigured machine shows no thinking level, texts %q", tester.Texts())
	}
	if !tester.HasText("模型") {
		t.Fatalf("the composer still offers the model chip, texts %q", tester.Texts())
	}
}

func TestThePickerExplainsAnEmptyModelList(t *testing.T) {
	state := emptyModelShell(t)
	state.chat.modelPicker.open = true
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("还没有可用的模型") {
		t.Fatalf("the picker explains why it is empty, texts %q", tester.Texts())
	}
	if !tester.HasText("去供应商页添加") {
		t.Fatalf("the picker points at where to add one, texts %q", tester.Texts())
	}
}

func TestAModelListThatArrivesLateReplacesTheEmptyState(t *testing.T) {
	state := emptyModelShell(t)
	state.chat.modelPicker.open = true
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("还没有可用的模型") {
		t.Fatalf("the picker starts empty, texts %q", tester.Texts())
	}
	state.chat.models = []modelChoice{{id: "command-goat:deepseek/deepseek-v4.1-flash", provider: "command-goat", thinking: "high", available: []string{"high", "low"}}}
	state.chat.modelsLoading = false
	frames(tester)
	if tester.HasText("还没有可用的模型") {
		t.Fatalf("the picker drops its empty state once models arrive, texts %q", tester.Texts())
	}
	if !tester.HasText("deepseek-v4.1-flash") {
		t.Fatalf("the picker lists the arrived model, texts %q", tester.Texts())
	}
}

func TestAMachineWithoutModelsPointsAtTheProvidersPage(t *testing.T) {
	state := emptyModelShell(t)
	opened := false
	state.chat.openProviders = func() { opened = true }
	state.chat.modelPicker.open = true
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("去供应商页添加"); err != nil {
		t.Fatalf("the empty picker offers a way to add a provider: %v texts %q", err, tester.Texts())
	}
	frames(tester)
	if !opened {
		t.Fatalf("the empty picker opens the providers page, texts %q", tester.Texts())
	}
}
