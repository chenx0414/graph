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
	],
	"requests":[{"id":"v1","model":"deepseek-v4","at":0,"contextTokens":42000,"input":100,"output":50,"cacheRead":80,"cacheWrite":20,"durationMs":1200}],
	"events":[{"at":1700000000000,"type":"session.compacted","text":"auto","tokens":42000}],
	"totals":{"turns":1,"requests":2,"modelReplies":1,"userMessages":1,"toolMessages":2,"compactions":1,
	 "toolCalls":1,"toolErrors":0,"input":100,"output":50,"cacheRead":80,"cacheWrite":20,
	 "totalTokens":250,"cost":0.02,"durationMs":7000,"cacheHitRate":0.4444,
	 "toolsByName":[{"name":"bash","count":1,"ms":4000,"errors":0}],
	 "timing":{"wallMs":7000,"ttftMs":250,"genMs":950,"toolMs":4000,"otherMs":1800},
	 "context":{"lastTokens":42000,"peakTokens":42000},
	 "commands":[{"name":"git","count":3},{"name":"go","count":2}],
	 "files":{"read":4,"write":2,"search":1,"image":0}}}`
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
	shell.openModule("trajectory")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	for _, wanted := range []string{"上下文统计窗口", "Token 统计窗口", "耗时统计窗口", "当前上下文窗口",
		"上下文趋势窗口", "上下文事件窗口", "命令执行窗口", "文件活动窗口",
		"轮次", "步数", "工具调用", "缓存命中", "44.4%", "bash", "未缓存输入", "首 token 等待", "峰值", "最近一次请求",
		"git", "读取", "上下文压缩", "次请求"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the trajectory dashboard shows %q, texts %q", wanted, tester.Texts())
		}
	}
	page := shell.boardPage()
	if page.Kind != "trajectory" || len(page.Panels) != 8 {
		t.Fatalf("the trajectory tab opens four cards, page %+v", page)
	}
}
