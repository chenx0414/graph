package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var usageFixtures = map[string]string{
	"/api/insights": `{"overview":{"turns":2633,"toolCalls":1000,"toolErrors":61,"costMicros":119226308},
		"tokens":{"total":1292450591,"cacheHitRate":0.9598},
		"models":[
			{"model":"grok-4.5","provider":"grok","calls":57,"costMicros":67217740},
			{"model":"deepseek-v4.1-flash","provider":"opencode-go","calls":563,"costMicros":4818730}
		]}`,
	"/api/usage": `{"plans":[
		{"name":"OpenCode Go","status":"ok","configured":true,"models":[{"id":"beam-free"},{"id":"cat-jam-free"}]},
		{"name":"Grok","status":"error","configured":false,"models":[]}
	]}`,
	"/api/capabilities/config": `{"items":[{"kind":"mcp","ready":true},{"kind":"mcp","ready":false},{"kind":"skills","ready":false}]}`,
}

func usageServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := usageFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func TestUsageSnapshotCountsAndFormats(t *testing.T) {
	snapshot, err := parseUsage([]byte(usageFixtures["/api/insights"]), []byte(usageFixtures["/api/usage"]), []byte(usageFixtures["/api/capabilities/config"]))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.turns != 2633 || snapshot.toolCalls != 1000 || snapshot.toolErrors != 61 || snapshot.costMicros != 119226308 {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if formatCost(snapshot.costMicros) != "$119.23" || formatTokens(snapshot.tokens) != "1.29B" || formatPercent(snapshot.cacheHit) != "96.0%" {
		t.Fatalf("format %q %q %q", formatCost(snapshot.costMicros), formatTokens(snapshot.tokens), formatPercent(snapshot.cacheHit))
	}
	if errorRate(snapshot) != "6.1%" {
		t.Fatalf("error rate %q", errorRate(snapshot))
	}
	if len(snapshot.models) != 2 || snapshot.models[0].name != "opencode-go · deepseek-v4.1-flash" {
		t.Fatalf("models must be ordered by calls, got %+v", snapshot.models)
	}
	if modelLabel(snapshot.models[0]) != "opencode-go · deepseek-v4.1-flash · 563 次 · $4.82" {
		t.Fatalf("model label %q", modelLabel(snapshot.models[0]))
	}
	if len(snapshot.plans) != 2 || snapshot.plans[0].state != "ok" || snapshot.plans[1].state != "未配置" {
		t.Fatalf("plans %+v", snapshot.plans)
	}
	if planLabel(snapshot.plans[0]) != "OpenCode Go · ok · 2 个模型" {
		t.Fatalf("plan label %q", planLabel(snapshot.plans[0]))
	}
	if snapshot.capabilities.ready != 1 || snapshot.capabilities.missing != 2 {
		t.Fatalf("capabilities %+v", snapshot.capabilities)
	}
}

func TestShellOpensTheUsagePane(t *testing.T) {
	server := usageServer(t)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	state.openModule("overview")
	if state.board.lastKind != "overview" || state.usage == nil {
		t.Fatalf("last %q", state.board.lastKind)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.usage.status != "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state.usage.status != "" {
		t.Fatalf("usage did not load, status %q", state.usage.status)
	}
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, wanted := range []string{"用量", "$119.23", "缓存命中", "96.0%", "能力库", "1/3", "tokens", "1.29B"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the overview must present %q, texts %q", wanted, tester.Texts())
		}
	}
}
