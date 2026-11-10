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

func TestBindingAConversationToAProject(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/bind":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"projectId":"mygo"}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"还没绑定项目"}]}`))
		case r.URL.Path == "/api/settings":
			w.Write([]byte(`{"projects":[{"id":"13-Graph"},{"id":"mygo"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := ui.NewTester(state.view, 760, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("绑定项目") {
		t.Fatalf("a conversation must offer the bind control, texts %q", tester.Texts())
	}
	if err := tester.Click("绑定项目"); err != nil {
		t.Fatalf("click 绑定项目: %v", err)
	}
	for frame := 0; frame < 5; frame++ {
		tester.Frame()
	}
	if !tester.HasText("绑定 mygo") {
		t.Fatalf("the choices must come from /api/settings, texts %q", tester.Texts())
	}
	if err := tester.Click("绑定 mygo"); err != nil {
		t.Fatalf("click 绑定 mygo: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for _, wanted := range []string{`"projectId":"mygo"`, `"requestId"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
	if state.project != "mygo" || state.binding || state.status != "已绑定到 mygo" {
		t.Fatalf("绑定后状态：project %q binding %v status %q", state.project, state.binding, state.status)
	}
}

func TestBindingRefusesAnEmptyProject(t *testing.T) {
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
		}
		w.Write([]byte(`{"messages":[]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.active = "c1"
	state.bindProject("  ")
	if posts != 0 {
		t.Fatalf("an empty project must not be sent, posts %d", posts)
	}
}

func TestConversationSwitchesModel(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/model":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"model":"opencode-go:deepseek"}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"用哪个模型？"}]}`))
		case r.URL.Path == "/api/settings":
			w.Write([]byte(`{"models":[
				{"id":"command-goat:deepseek/deepseek-v4.1-flash","defaultThinkingLevel":"high","thinkingOptions":[{"level":"high"},{"level":"low"}]},
				{"id":"opencode-go:deepseek","defaultThinkingLevel":"medium","thinkingOptions":[{"level":"medium"}]}
			]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := ui.NewTester(state.view, 900, 760)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("换模型") {
		t.Fatalf("a conversation must offer the model switch, texts %q", tester.Texts())
	}
	if err := tester.Click("换模型"); err != nil {
		t.Fatalf("click 换模型: %v", err)
	}
	for frame := 0; frame < 5; frame++ {
		tester.Frame()
	}
	if !tester.HasText("deepseek · medium") {
		t.Fatalf("the choices must show the short model and its thinking level, texts %q", tester.Texts())
	}
	if err := tester.Click("deepseek · medium"); err != nil {
		t.Fatalf("click a model: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for _, wanted := range []string{`"model":"opencode-go:deepseek"`, `"thinkingLevel":"medium"`, `"requestId"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
	if state.currentModel != "opencode-go:deepseek" || state.currentThinking != "medium" || state.modelMenu {
		t.Fatalf("切模型后状态：model %q thinking %q menu %v", state.currentModel, state.currentThinking, state.modelMenu)
	}
	if state.status != "已切到 deepseek · 思考 medium" {
		t.Fatalf("status %q", state.status)
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

func TestConfirmingADraftSendsBothRevisions(t *testing.T) {
	posted := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/confirm":
			payload := make([]byte, 4096)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			w.Write([]byte(`{"accepted":true}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"proposal":{"version":3,"draftRevision":7},"messages":[{"role":"assistant","text":"草案好了"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.proposal.Version != 3 || state.proposal.DraftRevision != 7 {
		t.Fatalf("proposal %+v", state.proposal)
	}
	tester := ui.NewTester(state.view, 900, 760)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("草案 v3 · 修订 7 待确认") {
		t.Fatalf("a waiting draft must be announced, texts %q", tester.Texts())
	}
	if state.branch != "main" {
		t.Fatalf("the target branch must default to main, got %q", state.branch)
	}
	if err := tester.Click("确认草图并开始执行"); err != nil {
		t.Fatalf("click 确认草图并开始执行: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for posted == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for _, wanted := range []string{`"proposalVersion":3`, `"draftRevision":7`, `"targetBranch":"main"`, `"requestId"`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体缺 %q，实际 %q", wanted, posted)
		}
	}
	deadline = time.Now().Add(2 * time.Second)
	for state.status == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.proposal.Version != 0 || state.status != "已确认草案，开始执行（目标分支 main）" {
		t.Fatalf("确认后状态：proposal %+v status %q", state.proposal, state.status)
	}
}

func TestConfirmRefusesAnEmptyBranch(t *testing.T) {
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
		}
		w.Write([]byte(`{"messages":[]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.active = "c1"
	state.proposal = draftProposal{Version: 1, DraftRevision: 2}
	state.branch = "   "
	state.confirmDraft()
	if posts != 0 || state.status != "目标分支不能为空" {
		t.Fatalf("an empty branch must stop before the request, posts %d status %q", posts, state.status)
	}
}
