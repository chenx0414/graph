package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"graph/app/gwui/palette"
)

const contextOverviewTrajectory = `{"conversationId":"c1","taskId":"t1","turns":[],
 "requests":[{"id":"v1","model":"deepseek/deepseek-v4.1-flash","at":1700000000000,"contextTokens":489300,"input":100,"output":50,"cacheRead":80,"cacheWrite":20,"durationMs":1200}],
 "events":[],
 "composition":{"systemPrompt":1900,"toolDefinitions":8600,"userMessages":265,"assistantReply":218000,"toolCalls":134500,"injected":5500,"reasoning":0},
 "agents":[{"nodeId":"n1","role":"master","instance":"i1","model":"deepseek/deepseek-v4.1-flash","requests":2,"tokens":250,"cost":0.02}],
 "totals":{"turns":1,"requests":2,"modelReplies":1,"userMessages":1,"toolMessages":2,"compactions":0,
  "toolCalls":1,"toolErrors":0,"input":100,"output":50,"cacheRead":80,"cacheWrite":20,
  "totalTokens":250,"cost":0.02,"durationMs":7000,"cacheHitRate":0.4444,
  "toolsByName":[],"timing":{"wallMs":7000,"ttftMs":250,"genMs":950,"toolMs":4000,"otherMs":1800},
  "context":{"lastTokens":489300,"peakTokens":512000},"commands":[],"paths":[],"files":{"read":4,"write":2,"search":1,"image":0}}}`

const contextOverviewSettings = `{"models":[
 {"id":"command-goat:deepseek/deepseek-v4.1-flash","modelId":"deepseek/deepseek-v4.1-flash","contextWindow":1000000,"maxTokens":384000}
]}`

func contextOverviewShell(t *testing.T, settings string) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1/trajectory":
			_, _ = w.Write([]byte(contextOverviewTrajectory))
		case "/api/settings":
			_, _ = w.Write([]byte(settings))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	shell.chat.currentModel = "command-goat:deepseek/deepseek-v4.1-flash"
	shell.ensureTrajectory()
	shell.ensureModelMeta()
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for (shell.trajectory.data == nil || shell.modelMeta == nil) && time.Now().Before(deadline) {
		tester.Frame()
	}
	if shell.trajectory.data == nil || shell.modelMeta == nil {
		t.Fatalf("the trajectory or the model meta never loaded: %q", shell.trajectory.failed)
	}
	return shell
}

func TestTheContextOverviewCardMirrorsTheContextComposition(t *testing.T) {
	shell := contextOverviewShell(t, contextOverviewSettings)
	shell.openModule("trajectory")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	for _, wanted := range []string{"当前上下文", "489.3k", "1.0M tokens", "48.9%", "上下文已用",
		"系统提示词", "≈2.5k", "1%", "工具定义", "≈11.4k", "2%", "用户消息", "≈351", "0%",
		"注入内容", "≈7.3k", "助手消息", "≈289.3k", "59%", "工具结果", "≈178.5k", "36%"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the context overview shows %q, texts %q", wanted, tester.Texts())
		}
	}
}

func TestTheContextOverviewLegendKeepsTheCategoryColors(t *testing.T) {
	shell := contextOverviewShell(t, contextOverviewSettings)
	shell.openModule("trajectory")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	img := tester.Image()
	colors := []ui.Color{palette.Indigo500.Color(), palette.Amber500.Color(), palette.Green500.Color(),
		palette.Purple500.Color(), palette.Blue500.Color(), palette.Teal500.Color()}
	for index, want := range colors {
		if count := countColor(img, want); count < 16 {
			t.Fatalf("category %d misses its color in the legend, pixels %d", index, count)
		}
	}
}

func TestTheContextOverviewFallsBackToAnEstimateWithoutAWindow(t *testing.T) {
	shell := contextOverviewShell(t, `{"models":[]}`)
	shell.openModule("trajectory")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	if !tester.HasText("tokens（估算）") {
		t.Fatalf("without a window the card estimates, texts %q", tester.Texts())
	}
	if tester.HasText("上下文已用") {
		t.Fatalf("without a window the card shows no percentage, texts %q", tester.Texts())
	}
}

func TestTheContextOverviewPartsKeepTheCategoryOrder(t *testing.T) {
	parts := contextOverviewParts(trajectoryComposition{
		SystemPrompt: 10, ToolDefinitions: 20, UserMessages: 30, Injected: 40, AssistantReply: 50, ToolCalls: 60,
	})
	wantKeys := []string{"system", "tools", "user", "inject", "assistant", "tool"}
	if len(parts) != len(wantKeys) {
		t.Fatalf("the card carries %d parts, want %d: %+v", len(parts), len(wantKeys), parts)
	}
	for index, key := range wantKeys {
		if parts[index].key != key {
			t.Fatalf("part %d is %q, want %q", index, parts[index].key, key)
		}
	}
	if parts[0].tokens != 10 || parts[5].tokens != 60 || parts[0].label != "系统提示词" {
		t.Fatalf("the parts carry the composition, parts %+v", parts)
	}
}

func TestTheContextOverviewSpansTheWholeRow(t *testing.T) {
	shell := contextOverviewShell(t, contextOverviewSettings)
	shell.openModule("trajectory")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	card, ok := tester.Find("当前上下文窗口")
	if !ok {
		t.Fatalf("the context overview never rendered, texts %q", tester.Texts())
	}
	timing, ok := tester.Find("耗时统计窗口")
	if !ok {
		t.Fatalf("the timing card never rendered, texts %q", tester.Texts())
	}
	summary, ok := tester.Find("上下文统计窗口")
	if !ok {
		t.Fatalf("the summary card never rendered, texts %q", tester.Texts())
	}
	if card.W <= timing.W*1.8 {
		t.Fatalf("the context overview takes a whole row, card %.1f timing %.1f", card.W, timing.W)
	}
	if card.Y <= summary.Y {
		t.Fatalf("the context overview follows the summary row, card %.1f summary %.1f", card.Y, summary.Y)
	}
	if timing.Y <= card.Y {
		t.Fatalf("the timing card follows the context overview, timing %.1f card %.1f", timing.Y, card.Y)
	}
}

func TestTheContextOverviewPrefersTheLatestRequestComposition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1/trajectory":
			_, _ = w.Write([]byte(`{"conversationId":"c1","taskId":"t1","turns":[],
			 "requests":[{"id":"v1","model":"deepseek/deepseek-v4.1-flash","at":1700000000000,"contextTokens":106200,
			  "composition":{"systemPrompt":1000,"toolDefinitions":3400,"userMessages":1200,"assistantReply":499200,"toolCalls":563300,"injected":12000}}],
			 "events":[],
			 "composition":{"systemPrompt":9000,"toolDefinitions":9000,"userMessages":9000,"assistantReply":9000,"toolCalls":9000,"injected":9000},
			 "agents":[],"totals":{"requests":1,"context":{"lastTokens":106200,"peakTokens":106200}}}`))
		case "/api/settings":
			_, _ = w.Write([]byte(contextOverviewSettings))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	shell.chat.currentModel = "command-goat:deepseek/deepseek-v4.1-flash"
	shell.ensureTrajectory()
	shell.ensureModelMeta()
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for (shell.trajectory.data == nil || shell.modelMeta == nil) && time.Now().Before(deadline) {
		tester.Frame()
	}
	shell.openModule("trajectory")
	tester = frames(ui.NewTester(shell.view, 1440, 900))
	if tester.HasText("≈9.0k") {
		t.Fatalf("the card uses the cumulative composition, texts %q", tester.Texts())
	}
	for _, wanted := range []string{"≈98", "≈334", "≈117", "≈1.2k", "≈49.1k", "≈55.4k"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the card uses the latest request composition, missing %q texts %q", wanted, tester.Texts())
		}
	}
}

func TestTheModelMetaMatchesProviderQualifiedIDs(t *testing.T) {
	shell := newShellState("http://127.0.0.1:1", "tok")
	shell.modelMeta = map[string]modelMeta{
		"command-goat:deepseek/deepseek-v4.1-flash-ultrafast": {id: "command-goat:deepseek/deepseek-v4.1-flash-ultrafast",
			modelID: "deepseek/deepseek-v4.1-flash-ultrafast", contextWindow: 1000000, maxTokens: 384000},
	}
	for _, model := range []string{
		"command-goat:deepseek/deepseek-v4.1-flash-ultrafast",
		"deepseek/deepseek-v4.1-flash-ultrafast",
		"deepseek-v4.1-flash-ultrafast",
		"deepseek-v4.1-flash",
	} {
		meta, ok := shell.modelMetaFor(model)
		if !ok || meta.contextWindow != 1000000 {
			t.Fatalf("model %q misses its window, meta %+v ok %v", model, meta, ok)
		}
	}
}
