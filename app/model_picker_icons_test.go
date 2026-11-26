package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const pickerBrandModelsFixture = `{"models":[
 {"id":"codex:gpt-5","provider":"codex","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"zeta:house-model","provider":"zeta","defaultThinkingLevel":"off","thinkingOptions":[{"level":"off"}]}
]}`

func pickerBrandState(t *testing.T) *chatState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/settings" {
			_, _ = w.Write([]byte(pickerBrandModelsFixture))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "")
	state.active = "c1"
	state.currentModel = "codex:gpt-5"
	state.loadModels()
	state.modelPicker.open = true
	return state
}

func exactText(texts []string, want string) bool {
	for _, text := range texts {
		if text == want {
			return true
		}
	}
	return false
}

func TestTheModelPickerShowsBrandIconsInsteadOfLetterTiles(t *testing.T) {
	state := pickerBrandState(t)
	tester := frames(newTester(state.view, 900, 700))
	texts := tester.Texts()
	if exactText(texts, "C") {
		t.Fatalf("a provider with a brand icon drops its letter tile, texts %q", texts)
	}
	if !exactText(texts, "Z") {
		t.Fatalf("a provider without a brand icon keeps its letter tile, texts %q", texts)
	}
	if !tester.HasText("gpt-5") || !tester.HasText("house-model") {
		t.Fatalf("both models stay listed, texts %q", texts)
	}
}
