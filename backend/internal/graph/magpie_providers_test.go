package graph

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMagpieFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func magpieFixtureDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeMagpieFile(t, dir, "providers.json", `{"providers":[
		{"id":"codex","name":"","key":""},
		{"id":"deepseek","name":"DeepSeek","preset":"deepseek","key":"sk-live-secret-should-not-leak",
		 "keys":[{"key":"sk-second-secret"}],"chat":"https://api.deepseek.com/v1"},
		{"id":"opencode-go","name":"OpenCode Go","preset":"opencode-go","key":"oc_sk_x",
		 "chat":"https://opencode.ai/inference/go/openai/v1"}
	],"groups":[{"id":"codex","name":"best-model","members":["codex/gpt-6-astra"]}]}`)
	writeMagpieFile(t, dir, "logins.json", `[
		{"id":"a1","agent":"codex","user":"a59@gmail.com","plan":"plus","on":true},
		{"id":"a2","agent":"codex","user":"w49@gmail.com","plan":"plus","on":false}
	]`)
	writeMagpieFile(t, dir, "quotas.json", `{
		"codex/a59@gmail.com":{"quota":{"plan":"plus","user":"a59@gmail.com","windows":[{"name":"5 hours","used":0},{"name":"7 days","used":70}]}},
		"deepseek/balance x":{"quota":{"plan":"","user":"sk-b…424e","windows":[]}}
	}`)
	writeMagpieFile(t, dir, "plugin-providers.json", `[{"id":"grok","name":"Grok (SuperGrok)"}]`)
	writeMagpieFile(t, dir, "gateway.json", `{"addr":"127.0.0.1:3999","pid":1,"version":"test","started":"2026-01-01T00:00:00Z"}`)
	return dir
}

func TestTheMagpieProvidersCarryAccountsPlansAndQuotas(t *testing.T) {
	dir := magpieFixtureDir(t)
	view := loadMagpieProviders(dir, "")
	if !view.Available {
		t.Fatalf("the fixture reads, error %q", view.Error)
	}
	if len(view.Providers) != 3 {
		t.Fatalf("three providers, got %+v", view.Providers)
	}
	codex := view.Providers[0]
	if codex.ID != "codex" || codex.Label != "ChatGPT" || codex.Badge != "套餐" {
		t.Fatalf("codex is the ChatGPT subscription, got %+v", codex)
	}
	if len(codex.Accounts) != 2 || codex.Accounts[0].User != "a59@gmail.com" || codex.Accounts[0].Plan != "plus" {
		t.Fatalf("codex keeps its signed-in accounts and plans, got %+v", codex.Accounts)
	}
	if !codex.Configured || codex.Off {
		t.Fatalf("codex is configured, got %+v", codex)
	}
	if len(codex.Quotas) == 0 || codex.Quotas[0].Window != "5 hours" {
		t.Fatalf("codex carries quota windows, got %+v", codex.Quotas)
	}
	deepseek := view.Providers[1]
	if deepseek.Badge != "按量付费" || deepseek.Chat != "https://api.deepseek.com/v1" {
		t.Fatalf("a keyed provider is pay-as-you-go, got %+v", deepseek)
	}
	payload := MagpieProvidersJSON(view)
	for _, secret := range []string{"sk-live-secret-should-not-leak", "sk-second-secret", "oc_sk_x"} {
		if strings.Contains(payload, secret) {
			t.Fatalf("keys never leave the daemon, leaked %q", secret)
		}
	}
	if !strings.Contains(payload, "api.deepseek.com") {
		t.Fatalf("the view keeps the endpoint, payload %s", payload)
	}
}

func TestTheMagpieModelsAreCountedPerProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"data":[
			{"id":"codex/gpt-6-astra","owned_by":"codex"},
			{"id":"codex/gpt-5-6-luna","owned_by":"codex"},
			{"id":"deepseek/deepseek-chat","owned_by":"deepseek"}
		]}`))
	}))
	defer server.Close()
	dir := magpieFixtureDir(t)
	view := loadMagpieProviders(dir, server.URL)
	if view.Models["codex"] != 2 || view.Models["deepseek"] != 1 {
		t.Fatalf("models count by provider, got %+v", view.Models)
	}
}

func TestAMissingMagpieDirectorySaysSo(t *testing.T) {
	view := loadMagpieProviders(filepath.Join(t.TempDir(), "nope"), "")
	if view.Available {
		t.Fatal("a missing dir is not available")
	}
	if view.Error == "" {
		t.Fatal("a missing dir explains itself")
	}
	if len(view.Providers) != 0 {
		t.Fatalf("no rows for a missing dir, got %+v", view.Providers)
	}
}

func TestTheMagpieProviderEndpointServesTheConfigDir(t *testing.T) {
	dir := magpieFixtureDir(t)
	t.Setenv("GRAPH_MAGPIE_DIR", dir)
	app := &GraphApp{}
	server := httptest.NewServer(http.HandlerFunc(app.serveMagpieProviders))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("200, got %d", response.StatusCode)
	}
}
