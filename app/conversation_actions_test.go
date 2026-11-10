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
