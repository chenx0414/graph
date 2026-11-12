package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTrajectoryModuleQuantifiesTheLatestConversation(t *testing.T) {
	payload := `{"conversationId":"c1","taskId":"t1","turns":[
		{"id":"u1","index":1,"startedAt":0,"endedAt":7000,"durationMs":7000,"status":"done","model":"deepseek-v4",
		 "usage":{"input":100,"output":50,"cacheRead":80,"cacheWrite":20,"total":250,"contextTokens":400,"firstTokenMs":250,"durationMs":1200},
		 "cost":0.02,"cacheHitRate":0.4444,
		 "toolCalls":[{"name":"bash","ms":4000,"isError":false,"at":4000}]}
	],"totals":{"turns":1,"toolCalls":1,"toolErrors":0,"input":100,"output":50,"cacheRead":80,"cacheWrite":20,
	 "totalTokens":250,"cost":0.02,"durationMs":7000,"cacheHitRate":0.4444}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations/c1/trajectory" {
			w.Write([]byte(payload))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	shell := newShellState(server.URL, "tok")
	shell.activeID = "c1"
	shell.ensureTrajectory()
	deadline := time.Now().Add(2 * time.Second)
	for shell.trajectory.data == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if shell.trajectory.data == nil {
		t.Fatalf("trajectory never loaded: %q", shell.trajectory.failed)
	}
	shell.board.pages = []boardPage{{
		ID: "tab-trajectory", Title: "轨迹量化", Kind: "trajectory",
		Panels: []boardPanel{{ID: "trajectory", Kind: "trajectory"}},
		Layout: boardNode{Kind: "panel", PanelID: "trajectory"},
	}}
	shell.board.active = 0
	tester := frames(ui.NewTester(shell.view, 1200, 800))
	for _, wanted := range []string{"轨迹量化窗口", "轮次", "工具调用", "Tokens", "缓存命中", "44.4%", "第 1 轮", "1 次工具", "bash", "首 token"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the trajectory panel shows %q, texts %q", wanted, tester.Texts())
		}
	}
}
