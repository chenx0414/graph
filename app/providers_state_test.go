package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const providersResolutionFixture = `{
 "available":true,
 "dir":"/Users/macmini/.config/magpie",
 "gateway":"127.0.0.1:3425",
 "models":{"opencode-go":2,"deepseek":1},
 "providers":[
  {"id":"opencode-go","label":"OpenCode Go","badge":"按量付费","chat":"https://opencode.ai/inference/go/openai/v1","host":"opencode.ai","keys":1,"configured":true,"accounts":[],"quotas":[]},
  {"id":"deepseek","label":"DeepSeek","badge":"按量付费","chat":"https://api.deepseek.com/v1","host":"api.deepseek.com","keys":0,"configured":false,"accounts":[],"quotas":[]}
 ]
}`

func providersFrameUntil(t *testing.T, tester *ui.Tester, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !done() && time.Now().Before(deadline) {
		tester.Frame()
	}
	tester.Frame()
}

func TestTheProvidersPageReadsConfiguredStateFromMagpie(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers/magpie":
			_, _ = w.Write([]byte(providersResolutionFixture))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) == 2 })

	if !tester.HasText("已连接") {
		t.Fatalf("a provider with a key is connected, texts %q", tester.Texts())
	}
	if !tester.HasText("未配置") {
		t.Fatalf("a provider with no key and no account is unconfigured, texts %q", tester.Texts())
	}
	if got := shell.providerStateOf("deepseek").Label(); got != "未配置" {
		t.Fatalf("deepseek reads %q", got)
	}
	if got := shell.providerStateOf("opencode-go").Label(); got != "已连接" {
		t.Fatalf("opencode-go reads %q", got)
	}
}

func TestTheProvidersPageKeepsAReadFailureUntilRetry(t *testing.T) {
	var hits int32
	var healthy atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers/magpie":
			atomic.AddInt32(&hits, 1)
			if !healthy.Load() {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(providersResolutionFixture))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return tester.HasText("读不到 magpie") })
	if !tester.HasText("读不到 magpie") {
		t.Fatalf("a failed read stays visible, texts %q", tester.Texts())
	}
	settled := atomic.LoadInt32(&hits)
	for frame := 0; frame < 20; frame++ {
		tester.Frame()
	}
	if got := atomic.LoadInt32(&hits); got != settled {
		t.Fatalf("a failed read must wait for the user, requests %d -> %d", settled, got)
	}
	healthy.Store(true)
	if err := tester.Click("重试供应商"); err != nil {
		t.Fatalf("retry the providers: %v", err)
	}
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) == 2 })
	if len(shell.providers.entries) != 2 {
		t.Fatalf("the retry loads the providers, entries %d failed %q", len(shell.providers.entries), shell.providers.failed)
	}
	if tester.HasText("读不到 magpie") {
		t.Fatalf("a recovered read clears the failure, texts %q", tester.Texts())
	}
}

func TestTheProvidersPageDoesNotCallALoadingListEmpty(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers/magpie":
			<-release
			_, _ = w.Write([]byte(providersResolutionFixture))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer close(release)

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTesterWith(shell.view, 1440, 900, ui.TesterOptions{Preferences: ui.Preferences{ReduceMotion: true}}))
	if _, ok := tester.Find("加载占位"); !ok {
		t.Fatalf("a pending read shows skeleton placeholders, texts %q", tester.Texts())
	}
	if tester.HasText("没有匹配的供应商") || tester.HasText("还没有供应商") {
		t.Fatalf("a pending read is not an empty list, texts %q", tester.Texts())
	}
}

func TestProviderStateReadsTheCredentialFacts(t *testing.T) {
	resolved, missing := true, false
	cases := []struct {
		name    string
		facts   providerFacts
		enabled bool
		want    providerState
	}{
		{"no credential at all", providerFacts{}, false, providerUnconfigured},
		{"credential resolved", providerFacts{Configured: true, Resolved: &resolved}, true, providerConnected},
		{"credential configured, secret gone", providerFacts{Configured: true, Resolved: &missing}, true, providerUnresolved},
		{"configured provider the user turned off", providerFacts{Configured: true, Resolved: &resolved}, false, providerDisabled},
		{"turned off and secret gone", providerFacts{Configured: true, Resolved: &missing}, false, providerUnresolved},
		{"credential kind without a resolution answer", providerFacts{Configured: true}, true, providerConnected},
	}
	for _, want := range cases {
		if got := providerStateOf(want.facts, want.enabled); got != want.want {
			t.Errorf("%s reads %q, want %q", want.name, got, want.want)
		}
	}
	for state, label := range map[providerState]string{
		providerUnconfigured: "未配置",
		providerUnresolved:   "凭据缺失",
		providerConnected:    "已连接",
		providerDisabled:     "未启用",
	} {
		if got := state.Label(); got != label {
			t.Errorf("state %q labels %q, want %q", state, got, label)
		}
	}
	if !providerConnected.Authenticated() || providerUnresolved.Authenticated() || providerUnconfigured.Authenticated() {
		t.Fatal("only a resolved credential can authenticate")
	}
}

func TestProvidersPhaseReadsLoadingFailureAndEmptiness(t *testing.T) {
	cases := []struct {
		name      string
		loading   bool
		attempted bool
		failed    string
		total     int
		want      providersPhase
	}{
		{"nothing attempted yet", false, false, "", 0, providersIdlePhase},
		{"first read", true, true, "", 0, providersLoadingPhase},
		{"read failed", false, true, "boom", 0, providersFailedPhase},
		{"loaded rows", false, true, "", 3, providersReadyPhase},
		{"loaded nothing", false, true, "", 0, providersEmptyPhase},
		{"a refresh keeps the rows", true, true, "", 3, providersReadyPhase},
		{"a failed refresh keeps the rows", false, true, "boom", 3, providersReadyPhase},
	}
	for _, want := range cases {
		if got := providersPhaseOf(want.loading, want.attempted, want.failed, want.total); got != want.want {
			t.Errorf("%s reads %q, want %q", want.name, got, want.want)
		}
	}
	if got := providersIdlePhase.Message(""); got != providersLoadingPhase.Message("") {
		t.Fatalf("an unread library looks like a read in progress, got %q", got)
	}
	if got := providersEmptyPhase.Message("zzz"); got != "没有匹配的供应商。" {
		t.Fatalf("an unmatched search says %q", got)
	}
	if got := providersEmptyPhase.Message(""); got != "还没有供应商。" {
		t.Fatalf("an empty library says %q", got)
	}
}
