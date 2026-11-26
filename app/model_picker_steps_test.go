package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

const pickerStepsFixture = `{"models":[
 {"id":"alpha:model-one","provider":"alpha","defaultThinkingLevel":"high","thinkingOptions":[{"level":"low"},{"level":"high"}]},
 {"id":"beta:model-two","provider":"beta","defaultThinkingLevel":"low","thinkingOptions":[{"level":"low"},{"level":"high"}]}
]}`

func pickerStepsServer(t *testing.T, mock *pickerMock) *httptest.Server {
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
			_, _ = w.Write([]byte(pickerStepsFixture))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func pickerStepsChat(t *testing.T, mock *pickerMock) *chatState {
	t.Helper()
	server := pickerStepsServer(t, mock)
	state := newChatState(server.URL, "")
	state.active = "c1"
	state.loadModels()
	state.modelPicker.open = true
	return state
}

func postedModels(mock *pickerMock) []string {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	return append([]string{}, mock.selected...)
}

func TestPickingAModelKeepsThePickerOpenForTheThinkingStep(t *testing.T) {
	mock := &pickerMock{}
	state := pickerStepsChat(t, mock)
	tester := frames(newTester(state.view, 900, 700))
	if !tester.HasText("模型选择器") {
		t.Fatalf("the picker starts open, texts %q", tester.Texts())
	}
	if err := tester.Click("model-two"); err != nil {
		t.Fatalf("pick the model: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("模型选择器") {
		t.Fatalf("picking a model keeps the picker open for the thinking step, texts %q", tester.Texts())
	}
	if got := postedModels(mock); len(got) != 0 {
		t.Fatalf("picking a model alone sends nothing, got %v", got)
	}
	row, ok := tester.AccessByRole(ui.RoleOption, "model-two")
	if !ok || !row.Selected {
		t.Fatalf("the picked model row reads as selected, got %+v (%v)", row, ok)
	}
	other, ok := tester.AccessByRole(ui.RoleOption, "model-one")
	if !ok || other.Selected {
		t.Fatalf("the other model row stays unselected, got %+v (%v)", other, ok)
	}
	level, ok := tester.AccessByRole(ui.RoleOption, "理由 Low")
	if !ok || !level.Selected {
		t.Fatalf("the thinking step starts on the model's default level, got %+v (%v)", level, ok)
	}
}

func TestTheThinkingStepSendsTheModelAndClosesThePicker(t *testing.T) {
	mock := &pickerMock{}
	state := pickerStepsChat(t, mock)
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("model-two"); err != nil {
		t.Fatalf("pick the model: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("理由 High"); err != nil {
		t.Fatalf("pick the thinking level: %v", err)
	}
	tester = frames(tester)
	if tester.HasText("模型选择器") {
		t.Fatalf("the thinking step closes the picker, texts %q", tester.Texts())
	}
	for frame := 0; frame < 200 && len(postedModels(mock)) == 0; frame++ {
		tester.Frame()
	}
	posted := postedModels(mock)
	if len(posted) != 1 {
		t.Fatalf("the thinking step sends one model change, got %v", posted)
	}
	if !strings.Contains(posted[0], `"model":"beta:model-two"`) || !strings.Contains(posted[0], `"thinkingLevel":"high"`) {
		t.Fatalf("the change carries the picked model and level, got %s", posted[0])
	}
	if state.currentModel != "beta:model-two" || state.currentThinking != "high" {
		t.Fatalf("the chat remembers the choice, got %q %q", state.currentModel, state.currentThinking)
	}
}

func TestPickingAProviderNarrowsTheModelStep(t *testing.T) {
	mock := &pickerMock{}
	state := pickerStepsChat(t, mock)
	tester := frames(newTester(state.view, 900, 700))
	if err := tester.Click("过滤 beta"); err != nil {
		t.Fatalf("pick the provider: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("model-two") {
		t.Fatalf("the provider keeps its model, texts %q", tester.Texts())
	}
	if tester.HasText("model-one") {
		t.Fatalf("the provider hides the other models, texts %q", tester.Texts())
	}
}

func TestClickingOutsideClosesTheModelPicker(t *testing.T) {
	state, _ := pickerChat(t)
	tester := frames(newTester(state.view, 900, 700))
	if !tester.HasText("模型选择器") {
		t.Fatalf("the picker starts open, texts %q", tester.Texts())
	}
	tester.ClickAt(450, 120)
	tester = frames(tester)
	if tester.HasText("模型选择器") {
		t.Fatalf("a press outside the picker closes it, texts %q", tester.Texts())
	}
	if state.modelPicker.open {
		t.Fatal("the picker remembers it is closed")
	}
}

func TestTheChatRestoresTheModelFromTelemetry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/conversations/c1":
			_, _ = w.Write([]byte(`{"telemetry":{"model":"alpha:model-one","thinkingLevel":"high"},"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"chat","text":"在的","state":"done"}]}`))
		case r.URL.Path == "/api/settings":
			_, _ = w.Write([]byte(pickerStepsFixture))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "")
	state.open("c1")
	if state.currentModel != "alpha:model-one" || state.currentThinking != "high" {
		t.Fatalf("opening the chat reads the model the console reports, got %q %q", state.currentModel, state.currentThinking)
	}
	tester := frames(newTester(state.view, 900, 700))
	if !tester.HasText("model-one high") {
		t.Fatalf("the model chip shows the restored model, texts %q", tester.Texts())
	}
}

func TestARefreshKeepsThePickedModelForOneRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/model"):
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/conversations/c1":
			_, _ = w.Write([]byte(`{"telemetry":{"model":"alpha:model-one","thinkingLevel":"high"},"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"chat","text":"在的","state":"done"}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "")
	state.open("c1")
	state.selectModel(modelChoice{id: "beta:model-two"}, "low")
	if state.currentModel != "beta:model-two" {
		t.Fatalf("the pick lands at once, got %q", state.currentModel)
	}
	state.refresh()
	if state.currentModel != "beta:model-two" {
		t.Fatalf("the read after the pick keeps it, got %q", state.currentModel)
	}
	state.refresh()
	if state.currentModel != "alpha:model-one" || state.currentThinking != "high" {
		t.Fatalf("the console is the truth from the next read on, got %q %q", state.currentModel, state.currentThinking)
	}
}
