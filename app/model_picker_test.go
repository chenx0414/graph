package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"
)

const pickerModelsFixture = `{"models":[
 {"id":"command-goat:deepseek/deepseek-v4.1-flash","defaultThinkingLevel":"high","thinkingOptions":[{"level":"minimal"},{"level":"low"},{"level":"medium"},{"level":"high"}]},
 {"id":"opencode-go:deepseek-v4.1-flash","defaultThinkingLevel":"max","thinkingOptions":[{"level":"low"},{"level":"high"},{"level":"max"}]},
 {"id":"opencode-go:longcat-2.5-preview-free","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"opencode-go:step-5-preview-free","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"opencode-go:qwen-3-coder","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"opencode-go:glm-4.7","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]}
]}`

type pickerMock struct {
	mu       sync.Mutex
	selected []string
}

func (m *pickerMock) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/model") && r.Method == http.MethodPost:
			body := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(body)
			m.mu.Lock()
			m.selected = append(m.selected, string(body))
			m.mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/settings":
			_, _ = w.Write([]byte(pickerModelsFixture))
		case strings.HasPrefix(r.URL.Path, "/api/conversations/") && strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = w.Write([]byte(`{"messages":[],"hasOlder":false}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func pickerChat(t *testing.T) (*chatState, *pickerMock) {
	t.Helper()
	mock := &pickerMock{}
	server := mock.server(t)
	state := newChatState(server.URL, "")
	state.active = "c1"
	state.currentModel = "command-goat:deepseek/deepseek-v4.1-flash"
	state.currentThinking = "high"
	state.loadModels()
	state.modelPicker.open = true
	return state, mock
}

func TestTheModelPickerShowsTheModelsAndTheReasoning(t *testing.T) {
	state, _ := pickerChat(t)
	tester := frames(newTester(state.view, 900, 700))
	for !tester.HasText("Reasoning") {
		tester.Frame()
		if len(tester.Texts()) == 0 {
			break
		}
		break
	}
	for _, want := range []string{"deepseek-v4.1-flash", "⌘1", "Reasoning", "Low", "Medium", "High", "Show more"} {
		if !tester.HasText(want) {
			t.Fatalf("the picker shows %q, texts %q", want, tester.Texts())
		}
	}
	if err := tester.Click("理由 Medium"); err != nil {
		t.Fatalf("pick a reasoning level: %v", err)
	}
}

func TestPickingAReasoningLevelChangesTheModel(t *testing.T) {
	state, mock := pickerChat(t)
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("理由 High"); err != nil {
		t.Fatalf("pick the high level: %v", err)
	}
	tester = frames(tester)
	// The change goes out from a goroutine so the window never waits on the
	// console; give it a bounded number of frames to land before asserting, so a
	// loaded machine cannot turn the read into a flake.
	sent := func() int {
		mock.mu.Lock()
		defer mock.mu.Unlock()
		return len(mock.selected)
	}
	for frame := 0; frame < 200 && sent() == 0; frame++ {
		tester.Frame()
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.selected) == 0 {
		t.Fatalf("the picker sends the model change, got %v (%q)", mock.selected, state.status)
	}
	if !strings.Contains(mock.selected[0], `"thinkingLevel":"high"`) {
		t.Fatalf("the change carries the chosen level, got %s", mock.selected[0])
	}
}

func TestHidingAProviderFiltersThePicker(t *testing.T) {
	state, _ := pickerChat(t)
	state.providerOn = func(id string) bool { return id != "opencode-go" }
	tester := frames(newTester(state.view, 900, 700))
	if tester.HasText("longcat-2.5-preview-free") {
		t.Fatalf("a disabled provider keeps its models out, texts %q", tester.Texts())
	}
	if !tester.HasText("deepseek/deepseek-v4.1-flash") && !tester.HasText("deepseek-v4.1-flash") {
		t.Fatalf("the enabled provider keeps its models, texts %q", tester.Texts())
	}
}

func TestShowMoreRevealsTheRest(t *testing.T) {
	state, _ := pickerChat(t)
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("Show more"); err != nil {
		t.Fatalf("expand the list: %v", err)
	}
	tester = frames(tester)
	if tester.HasText("Show more") {
		t.Fatalf("the expanded list drops the toggle, texts %q", tester.Texts())
	}
	if !tester.HasText("glm-4.7") {
		t.Fatalf("the expanded list shows the rest, texts %q", tester.Texts())
	}
}

func TestTheModelChipOpensThePicker(t *testing.T) {
	state, _ := pickerChat(t)
	state.modelPicker.open = false
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("模型"); err != nil {
		t.Fatalf("click the model chip: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("Reasoning") {
		t.Fatalf("the chip opens the picker, texts %q", tester.Texts())
	}
}

func TestCommandNumberSelectsTheModelTheChipAdvertises(t *testing.T) {
	state, mock := pickerChat(t)
	state.modelPicker.open = false
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("模型"); err != nil {
		t.Fatalf("open the picker: %v", err)
	}
	frames(tester)
	tester.Key(ui.Cmd, ui.Key2)
	tester = frames(tester)
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.selected) == 0 {
		t.Fatalf("⌘2 posts the second visible model, got %v (%q)", mock.selected, state.status)
	}
	if !strings.Contains(mock.selected[0], "opencode-go:deepseek-v4.1-flash") {
		t.Fatalf("⌘2 picks the second visible model, got %s", mock.selected[0])
	}
	if state.modelPicker.open {
		t.Fatal("picking by shortcut closes the picker")
	}
}
