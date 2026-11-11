package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestInterruptAppearsOnlyWhileARoundIsRunning(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/interrupt":
			if r.Header.Get("Origin") != "http://"+r.Host {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"interrupted":true}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"user","text":"跑一下"},{"role":"assistant","state":"streaming","text":"正在写"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if !state.busy() {
		t.Fatal("a streaming reply means the round is running")
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("打断这一轮") {
		t.Fatalf("a running round must offer the interrupt, texts %q", tester.Texts())
	}
	if err := tester.Click("打断这一轮"); err != nil {
		t.Fatalf("click 打断这一轮: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for posted == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !contains(posted, "requestId") {
		t.Fatalf("打断必须带 requestId，提交体 %q", posted)
	}
	deadline = time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.status != "已请求打断这一轮" {
		t.Fatalf("status %q", state.status)
	}
}

func TestQueuedMessagesCanBeCancelled(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/messages/m9/cancel":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"cancelled":true}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"id":"m9","role":"user","state":"queued","text":"等下一轮再说"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.busy() {
		t.Fatal("a queued message is not a running round")
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("撤销这条排队消息") {
		t.Fatalf("a queued message must offer the cancel, texts %q", tester.Texts())
	}
	if tester.HasText("打断这一轮") {
		t.Fatalf("an idle round must not offer the interrupt, texts %q", tester.Texts())
	}
	if err := tester.Click("撤销这条排队消息"); err != nil {
		t.Fatalf("click 撤销这条排队消息: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for posted == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !contains(posted, "requestId") {
		t.Fatalf("撤销必须带 requestId，提交体 %q", posted)
	}
	deadline = time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.status != "已撤销排队消息" {
		t.Fatalf("status %q", state.status)
	}
}

func TestConversationPauseAndResume(t *testing.T) {
	posted := map[string]string{}
	paused := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted[r.URL.Path] = string(payload[:read])
			switch {
			case strings.HasSuffix(r.URL.Path, "/pause"):
				paused = true
			case strings.HasSuffix(r.URL.Path, "/resume"):
				paused = false
			}
			w.Write([]byte(`{}`))
			return
		}
		if r.URL.Path == "/api/conversations/c1" {
			state := "null"
			if paused {
				state = "true"
			}
			w.Write([]byte(`{"paused":` + state + `,"messages":[{"role":"assistant","text":"等你决定"}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.paused {
		t.Fatal("a fresh conversation starts running")
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("暂停") || tester.HasText("继续") {
		t.Fatalf("a running conversation must offer 暂停 only, texts %q", tester.Texts())
	}
	if err := tester.Click("暂停"); err != nil {
		t.Fatalf("click 暂停: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !contains(posted["/api/conversations/c1/pause"], "requestId") {
		t.Fatalf("暂停必须打 pause 路由并带 requestId，posts %v", posted)
	}
	if !state.paused || !contains(state.status, "已暂停") {
		t.Fatalf("暂停后状态必须是已暂停，paused %v status %q", state.paused, state.status)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("继续") {
		t.Fatalf("a paused conversation must offer 继续, texts %q", tester.Texts())
	}
	if err := tester.Click("继续"); err != nil {
		t.Fatalf("click 继续: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for state.paused && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !contains(posted["/api/conversations/c1/resume"], "requestId") || state.paused {
		t.Fatalf("继续必须打 resume 路由，posts %v paused %v", posted, state.paused)
	}
}

func TestPausedStateComesFromTheConversation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"paused":true,"messages":[{"role":"assistant","text":"停着呢"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if !state.paused {
		t.Fatal("the conversation says it is paused, so the pane must say so")
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("继续") || tester.HasText("暂停") {
		t.Fatalf("a paused conversation must offer 继续 only, texts %q", tester.Texts())
	}
}

func TestTheModelModuleSwitchesTheConversationModel(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/conversations/c1/model" {
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"model":"opencode-go:deepseek"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	chat := newChatState(server.URL, "tok")
	chat.active = "c1"
	chat.models = []modelChoice{
		{id: "command-goat:deepseek/deepseek-v4.1-flash", thinking: "high", available: []string{"high", "low"}},
		{id: "opencode-go:deepseek", thinking: "medium", available: []string{"medium"}},
	}
	state := newShellState(server.URL, "tok")
	state.chat = chat
	state.activeID = "c1"
	state.board.panels = []boardPanel{{ID: "models", Kind: "models", X: 20, Y: 20, W: 460, H: 320}}
	tester := ui.NewTester(state.view, 1100, 760)
	frames(tester)
	if !tester.HasText("模型配置") || !tester.HasText("deepseek-v4.1-flash") || !tester.HasText("deepseek") {
		t.Fatalf("the model module must list the choices, texts %q", tester.Texts())
	}
	if err := tester.Click("medium"); err != nil {
		t.Fatalf("click a thinking level: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for posted == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for _, wanted := range []string{`"model":"opencode-go:deepseek"`, `"thinkingLevel":"medium"`, `"requestId"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
	if chat.currentModel != "opencode-go:deepseek" || chat.currentThinking != "medium" {
		t.Fatalf("切模型后状态：model %q thinking %q", chat.currentModel, chat.currentThinking)
	}
}

func TestShortModelName(t *testing.T) {
	cases := map[string]string{
		"command-goat:deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash",
		"opencode-go:deepseek":                      "deepseek",
		"plain-model":                               "plain-model",
	}
	for id, want := range cases {
		if got := shortModel(id); got != want {
			t.Fatalf("shortModel(%q) = %q, want %q", id, got, want)
		}
	}
}
