package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestInsightsModuleSummarizesTheLastSevenDays(t *testing.T) {
	payload := `{"days":[
		{"date":"2026-11-06","requests":10,"tokens":1000,"cost":0.01,"cacheHitRate":0.9},
		{"date":"2026-11-07","requests":12,"tokens":1200,"cost":0.02,"cacheHitRate":0.9},
		{"date":"2026-11-08","requests":14,"tokens":1400,"cost":0.03,"cacheHitRate":0.9},
		{"date":"2026-11-09","requests":16,"tokens":1600,"cost":0.04,"cacheHitRate":0.9},
		{"date":"2026-11-10","requests":18,"tokens":1800,"cost":0.05,"cacheHitRate":0.9},
		{"date":"2026-11-11","requests":20,"tokens":2000,"cost":0.06,"cacheHitRate":0.9},
		{"date":"2026-11-12","requests":22,"tokens":2200,"cost":0.07,"cacheHitRate":0.9}
	],"totals":{"requests":112,"tokens":11200,"cost":0.28,"cacheHitRate":0.9,"sessions":2},
	"sessions":[
		{"conversationId":"c1","title":"主控会话","requests":100,"tokens":10000,"cost":0.25,"lastAt":1700000000000},
		{"conversationId":"c2","title":"实验会话","requests":12,"tokens":1200,"cost":0.03,"lastAt":1700000000000}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/trajectory/insights" {
			w.Write([]byte(payload))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	shell := newShellState(server.URL, "tok")
	shell.ensureInsights()
	deadline := time.Now().Add(2 * time.Second)
	for shell.insights.data == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if shell.insights.data == nil {
		t.Fatalf("insights never loaded: %q", shell.insights.failed)
	}
	shell.openModule("insights")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	for _, wanted := range []string{"洞察概览窗口", "用量趋势窗口", "会话排行窗口", "总 tokens", "11.2k", "$0.280", "112", "缓存命中", "主控会话", "100 次", "● 7 天", "○ 30 天"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the insights dashboard shows %q, texts %q", wanted, tester.Texts())
		}
	}
	if page := shell.boardPage(); page.Kind != "insights" || len(page.Panels) != 3 {
		t.Fatalf("insights page %+v", page)
	}
}
