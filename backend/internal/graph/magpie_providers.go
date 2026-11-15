package graph

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type magpieProviderAccount struct {
	User string `json:"user"`
	Plan string `json:"plan"`
	On   bool   `json:"on"`
}

type magpieQuotaWindow struct {
	Window string  `json:"window"`
	Used   float64 `json:"used"`
}

type magpieProviderRow struct {
	ID         string                  `json:"id"`
	Label      string                  `json:"label"`
	Icon       string                  `json:"icon,omitempty"`
	Badge      string                  `json:"badge"`
	Chat       string                  `json:"chat,omitempty"`
	Website    string                  `json:"website,omitempty"`
	KeysURL    string                  `json:"keysUrl,omitempty"`
	Host       string                  `json:"host,omitempty"`
	Keys       int                     `json:"keys"`
	Configured bool                    `json:"configured"`
	Off        bool                    `json:"off"`
	Accounts   []magpieProviderAccount `json:"accounts"`
	Quotas     []magpieQuotaWindow     `json:"quotas"`
}

type magpieProvidersView struct {
	Available bool                `json:"available"`
	Dir       string              `json:"dir"`
	Error     string              `json:"error,omitempty"`
	Gateway   string              `json:"gateway,omitempty"`
	Models    map[string]int      `json:"models"`
	Providers []magpieProviderRow `json:"providers"`
}

func magpieConfigDir() string {
	if dir := strings.TrimSpace(os.Getenv("GRAPH_MAGPIE_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "magpie")
}

type magpieProvidersFile struct {
	Providers []struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Icon      string `json:"icon"`
		Preset    string `json:"preset"`
		Key       string `json:"key"`
		Chat      string `json:"chat"`
		Responses string `json:"responses"`
		Website   string `json:"website"`
		KeysURL   string `json:"keysUrl"`
		Off       bool   `json:"off"`
		Keys      []struct {
			Key string `json:"key"`
		} `json:"keys"`
	} `json:"providers"`
}

type magpiePluginProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type magpieQuotaFile map[string]struct {
	Quota struct {
		Plan    string `json:"plan"`
		User    string `json:"user"`
		Windows []struct {
			Name string  `json:"name"`
			Used float64 `json:"used"`
		} `json:"windows"`
	} `json:"quota"`
}

var magpieProviderLabels = map[string]string{
	"codex":            "ChatGPT",
	"claude":           "Claude",
	"grok":             "Grok",
	"deepseek":         "DeepSeek",
	"opencode-go":      "OpenCode Go",
	"commandcode-plan": "Command Code Plan",
	"gemini":           "Google Gemini",
	"openrouter":       "OpenRouter",
}

func readMagpieJSON(dir, name string, target any) bool {
	payload, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return false
	}
	return json.Unmarshal(payload, target) == nil
}

func magpieProviderBadge(hasPlan, hasKey, custom bool) string {
	switch {
	case hasPlan:
		return "套餐"
	case custom:
		return "自建"
	case hasKey:
		return "按量付费"
	}
	return "套餐"
}

func magpieHostOf(chat string) string {
	trimmed := strings.TrimSpace(chat)
	if trimmed == "" {
		return ""
	}
	parsed, err := urlParseLoose(trimmed)
	if err != nil {
		return trimmed
	}
	return parsed
}

func urlParseLoose(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "https://")
	trimmed = strings.TrimPrefix(trimmed, "http://")
	host := trimmed
	if index := strings.IndexAny(host, "/"); index >= 0 {
		host = host[:index]
	}
	if host == "" {
		return "", errEmptyHost{}
	}
	return host, nil
}

type errEmptyHost struct{}

func (errEmptyHost) Error() string { return "empty host" }

func loadMagpieProviders(dir, gateway string) magpieProvidersView {
	view := magpieProvidersView{Dir: dir, Models: map[string]int{}, Providers: []magpieProviderRow{}}
	if dir == "" {
		view.Error = "找不到 magpie 的配置目录"
		return view
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		view.Error = "读不到 magpie 的配置目录 " + shortMagpiePath(dir)
		return view
	}
	var providers magpieProvidersFile
	if !readMagpieJSON(dir, "providers.json", &providers) {
		view.Error = "读不到 magpie 的 providers.json"
		return view
	}
	names := map[string]string{}
	var plugins []magpiePluginProvider
	if readMagpieJSON(dir, "plugin-providers.json", &plugins) {
		for _, plugin := range plugins {
			if plugin.ID != "" && plugin.Name != "" {
				names[plugin.ID] = plugin.Name
			}
		}
	}
	accounts := map[string][]magpieProviderAccount{}
	var logins []struct {
		Agent string `json:"agent"`
		User  string `json:"user"`
		Plan  string `json:"plan"`
		On    bool   `json:"on"`
	}
	if readMagpieJSON(dir, "logins.json", &logins) {
		for _, login := range logins {
			agent := strings.TrimPrefix(login.Agent, "plugin:")
			if agent == "" {
				continue
			}
			accounts[agent] = append(accounts[agent], magpieProviderAccount{User: login.User, Plan: login.Plan, On: login.On})
		}
	}
	quotas := map[string][]magpieQuotaWindow{}
	var quotaFile magpieQuotaFile
	if readMagpieJSON(dir, "quotas.json", &quotaFile) {
		for key, entry := range quotaFile {
			provider := strings.SplitN(key, "/", 2)[0]
			for _, window := range entry.Quota.Windows {
				quotas[provider] = append(quotas[provider], magpieQuotaWindow{Window: window.Name, Used: window.Used})
			}
		}
	}
	view.Gateway = gateway
	if gateway != "" {
		view.Models = fetchMagpieModelCounts(gateway)
	}
	for _, provider := range providers.Providers {
		if provider.ID == "" {
			continue
		}
		label := strings.TrimSpace(provider.Name)
		if label == "" {
			label = names[provider.ID]
		}
		if label == "" {
			label = magpieProviderLabels[provider.ID]
		}
		if label == "" {
			label = provider.ID
		}
		keyCount := 0
		if strings.TrimSpace(provider.Key) != "" {
			keyCount++
		}
		keyCount += len(provider.Keys)
		providerAccounts := accounts[provider.ID]
		hasPlan := false
		for _, account := range providerAccounts {
			if strings.TrimSpace(account.Plan) != "" || account.On {
				hasPlan = true
			}
		}
		custom := provider.Preset == "" && names[provider.ID] == "" && len(providerAccounts) == 0
		view.Providers = append(view.Providers, magpieProviderRow{
			ID: provider.ID, Label: label, Icon: provider.Icon,
			Badge: magpieProviderBadge(hasPlan, keyCount > 0, custom),
			Chat:  provider.Chat, Website: provider.Website, KeysURL: provider.KeysURL,
			Host: magpieHostOf(provider.Chat), Keys: keyCount,
			Configured: keyCount > 0 || len(providerAccounts) > 0, Off: provider.Off,
			Accounts: providerAccounts, Quotas: quotas[provider.ID],
		})
	}
	view.Available = true
	return view
}

func shortMagpiePath(path string) string {
	if len(path) <= 42 {
		return path
	}
	return "…" + path[len(path)-42:]
}

func fetchMagpieModelCounts(gateway string) map[string]int {
	counts := map[string]int{}
	address := strings.TrimSuffix(gateway, "/")
	if !strings.HasPrefix(address, "http") {
		address = "http://" + address
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(address + "/v1/models")
	if err != nil {
		return counts
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return counts
	}
	var body struct {
		Data []struct {
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if json.NewDecoder(response.Body).Decode(&body) != nil {
		return counts
	}
	for _, model := range body.Data {
		if model.OwnedBy != "" {
			counts[model.OwnedBy]++
		}
	}
	return counts
}

func magpieGatewayAddress(dir string) string {
	var gateway struct {
		Addr string `json:"addr"`
	}
	if !readMagpieJSON(dir, "gateway.json", &gateway) {
		return ""
	}
	host, port, err := net.SplitHostPort(gateway.Addr)
	if err != nil {
		return gateway.Addr
	}
	if host == "" || host == "::" || host == "[::]" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}

func MagpieProvidersJSON(view magpieProvidersView) string {
	encoded, err := json.Marshal(view)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func (app *GraphApp) serveMagpieProviders(w http.ResponseWriter, r *http.Request) {
	dir := magpieConfigDir()
	writeJSON(w, http.StatusOK, loadMagpieProviders(dir, magpieGatewayAddress(dir)))
}
