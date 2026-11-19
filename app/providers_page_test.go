package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

const magpieProvidersFixture = `{
 "available":true,
 "dir":"/Users/macmini/.config/magpie",
 "gateway":"127.0.0.1:3425",
 "models":{"codex":3,"deepseek":2},
 "providers":[
  {"id":"codex","label":"ChatGPT","badge":"套餐","keys":0,"configured":true,
   "accounts":[{"user":"a59@gmail.com","plan":"plus","on":true},{"user":"w49@gmail.com","plan":"plus","on":true}],
   "quotas":[{"window":"5 hours","used":0},{"window":"7 days","used":70}]},
  {"id":"deepseek","label":"DeepSeek","badge":"按量付费","chat":"https://api.deepseek.com/v1",
   "host":"api.deepseek.com","keys":2,"configured":true,"accounts":[],"quotas":[]},
  {"id":"gemini","label":"Google Gemini","badge":"套餐","keys":0,"configured":false,"accounts":[],"quotas":[]}
 ]
}`

func magpieProvidersServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers/magpie":
			_, _ = w.Write([]byte(magpieProvidersFixture))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTheProvidersPageReadsMagpie(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if len(shell.providers.entries) != 3 {
		t.Fatalf("every magpie provider is listed, got %d (%q)", len(shell.providers.entries), shell.providers.failed)
	}
	for _, want := range []string{
		"模型", "供应商", "Magpie（扩展）",
		"ChatGPT", "DeepSeek", "Google Gemini",
		"套餐", "按量付费",
		"api.deepseek.com · 2 个模型",
		"2 个账号（plus）",
		"5 小时 0.0% · 7 天 70.0%",
		"已连接", "未配置",
	} {
		if !tester.HasText(want) {
			t.Fatalf("the providers page shows %q, texts %q", want, tester.Texts())
		}
	}
}

func TestTheProvidersPageSaysWhereTheDataComesFrom(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if !tester.HasText("Magpie") {
		t.Fatalf("the page names its data source, texts %q", tester.Texts())
	}
	if shell.providers.source.Dir != "/Users/macmini/.config/magpie" {
		t.Fatalf("the page remembers the magpie dir, got %q", shell.providers.source.Dir)
	}
}

func TestAnUnreadableMagpieSaysSoAndRetries(t *testing.T) {
	available := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if available {
			_, _ = w.Write([]byte(magpieProvidersFixture))
			return
		}
		_, _ = w.Write([]byte(`{"available":false,"dir":"/Users/macmini/.config/magpie","error":"读不到 magpie 的配置目录 /Users/macmini/.config/magpie","providers":[]}`))
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return tester.HasText("读不到 magpie") })
	if !tester.HasText("读不到 magpie") {
		t.Fatalf("a missing magpie is reported, texts %q", tester.Texts())
	}
	available = true
	if err := tester.Click("重试供应商"); err != nil {
		t.Fatalf("retry providers: %v", err)
	}
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) == 3 })
	if len(shell.providers.entries) != 3 {
		t.Fatalf("the retry reads magpie, entries %d failed %q", len(shell.providers.entries), shell.providers.failed)
	}
}

func TestTheProviderSwitchIsReadOnlyBecauseMagpieOwnsIt(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if !tester.HasText("开关在 Magpie 里") {
		t.Fatalf("the page says where the switch lives, texts %q", tester.Texts())
	}
	if !tester.HasText("Magpie 开") {
		t.Fatalf("a connected provider shows magpie's open state, texts %q", tester.Texts())
	}
	if !shell.providersEnabled("codex") {
		t.Fatal("the row reflects magpie, not a local switch")
	}
}

func TestClickingAProviderOpensItsModels(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	chat := newChatState(server.URL, "")
	chat.active = "c1"
	chat.providerOn = shell.providersEnabled
	shell.chat = chat
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if err := tester.Click("用 ChatGPT 的模型"); err != nil {
		t.Fatalf("open the provider's models: %v", err)
	}
	frames(tester)
	if !chat.modelPicker.open || chat.modelPicker.provider != "codex" {
		t.Fatalf("the row opens the picker on that provider, got %+v", chat.modelPicker)
	}
}

func TestTheProviderRowsUseTheRealBrandIcons(t *testing.T) {
	for _, id := range []string{"opencode-go", "command-goat", "deepseek", "chatgpt", "codex", "anthropic", "google-gemini", "gemini", "openai", "openrouter", "grok", "commandcode-plan"} {
		if providerBrandIcon(id) == nil {
			t.Fatalf("the provider %q has its brand icon", id)
		}
	}
	if providerBrandIcon("self-host") != nil {
		t.Fatalf("a custom provider falls back to a letter tile, not a brand icon")
	}
}

func TestThePickerFollowsMagpieWithoutHidingUnknownProviders(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })

	if !shell.providersEnabled("codex") {
		t.Fatal("a connected magpie provider feeds the picker")
	}
	if !shell.providersEnabled("command-goat") {
		t.Fatal("a graph provider magpie does not know stays available")
	}
	if !shell.providersEnabled("some-model-provider") {
		t.Fatal("an unknown provider is not hidden by magpie")
	}
	if shell.providersEnabled("gemini") {
		t.Fatal("an unconfigured magpie provider stays off")
	}
}

func TestAProviderSwitchedOffInMagpieIsOff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"available":true,"dir":"/d","providers":[
			{"id":"codex","label":"ChatGPT","badge":"套餐","configured":true,"off":true,"accounts":[{"user":"a@b","plan":"plus","on":true}]}
		],"models":{}}`))
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if shell.providersEnabled("codex") {
		t.Fatal("a provider magpie switched off is off here")
	}
	if got := shell.providerStateOf("codex").Label(); got != "未启用" {
		t.Fatalf("the row reads %q", got)
	}
}

func TestTheProvidersPageDoesNotOfferFakeWriteActions(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if !tester.HasText("添加供应商") {
		t.Fatalf("the page offers its own provider onboarding, texts %q", tester.Texts())
	}
	if tester.HasText("账号打包") {
		t.Fatalf("the magpie section stays read-only, texts %q", tester.Texts())
	}
	if !tester.HasText("供应商与账号都由 Magpie 管理") {
		t.Fatalf("the page says who owns the magpie rows, texts %q", tester.Texts())
	}
}

func TestTheProvidersPageRefreshesWhenMagpieChanges(t *testing.T) {
	refreshed := false
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/providers/magpie" {
			http.NotFound(w, r)
			return
		}
		calls++
		if !refreshed {
			_, _ = w.Write([]byte(magpieProvidersFixture))
			return
		}
		_, _ = w.Write([]byte(`{"available":true,"dir":"/Users/macmini/.config/magpie","gateway":"127.0.0.1:3425","models":{"codex":3,"deepseek":2,"grok":8},"providers":[
		 {"id":"codex","label":"ChatGPT","badge":"套餐","keys":0,"configured":true,"accounts":[],"quotas":[]},
		 {"id":"deepseek","label":"DeepSeek","badge":"按量付费","keys":2,"configured":true,"accounts":[],"quotas":[]},
		 {"id":"gemini","label":"Google Gemini","badge":"套餐","keys":0,"configured":false,"accounts":[],"quotas":[]},
		 {"id":"grok","label":"Grok","badge":"套餐","keys":0,"configured":true,"accounts":[],"quotas":[]}
		]}`))
	}))
	defer server.Close()

	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) == 3 })
	refreshed = true
	if err := tester.Click("刷新供应商"); err != nil {
		t.Fatalf("refresh providers: %v", err)
	}
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) == 4 })
	if calls < 2 || len(shell.providers.entries) != 4 {
		t.Fatalf("the refresh reads magpie again, calls %d entries %d (%q)", calls, len(shell.providers.entries), shell.providers.failed)
	}
}

func TestTheProvidersPageOpensMagpieWhenTheSwitchLivesThere(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	opened := ""
	shell.providers.openPath = func(path string) error { opened = path; return nil }
	shell.openModule("providers")
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	if err := tester.Click("打开 Magpie 配置"); err != nil {
		t.Fatalf("open magpie: %v", err)
	}
	frames(tester)
	if opened != "/Users/macmini/.config/magpie/providers.json" {
		t.Fatalf("the page opens magpie's providers file, got %q", opened)
	}
}
