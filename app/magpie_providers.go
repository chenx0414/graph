package main

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
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

type magpieProvidersPayload struct {
	Available bool           `json:"available"`
	Dir       string         `json:"dir"`
	Error     string         `json:"error"`
	Gateway   string         `json:"gateway"`
	Models    map[string]int `json:"models"`
	Providers []struct {
		ID         string                  `json:"id"`
		Label      string                  `json:"label"`
		Icon       string                  `json:"icon"`
		Badge      string                  `json:"badge"`
		Chat       string                  `json:"chat"`
		Website    string                  `json:"website"`
		KeysURL    string                  `json:"keysUrl"`
		Host       string                  `json:"host"`
		Keys       int                     `json:"keys"`
		Configured bool                    `json:"configured"`
		Off        bool                    `json:"off"`
		Accounts   []magpieProviderAccount `json:"accounts"`
		Quotas     []magpieQuotaWindow     `json:"quotas"`
	} `json:"providers"`
}

func magpieWindowLabel(window string) string {
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "5 hours":
		return "5 小时"
	case "7 days":
		return "7 天"
	case "weekly":
		return "每周"
	case "month":
		return "每月"
	case "credits":
		return "点数"
	}
	return window
}

func magpieQuotaSummary(quotas []magpieQuotaWindow) string {
	if len(quotas) == 0 {
		return ""
	}
	parts := make([]string, 0, len(quotas))
	for index, quota := range quotas {
		if index >= 2 {
			break
		}
		parts = append(parts, magpieWindowLabel(quota.Window)+" "+formatPercent(quota.Used/100))
	}
	return strings.Join(parts, " · ")
}

func magpieAccountSummary(accounts []magpieProviderAccount) string {
	if len(accounts) == 0 {
		return ""
	}
	plans := map[string]bool{}
	for _, account := range accounts {
		if account.Plan != "" {
			plans[account.Plan] = true
		}
	}
	label := strconv.Itoa(len(accounts)) + " 个账号"
	if len(plans) > 0 {
		names := make([]string, 0, len(plans))
		for plan := range plans {
			names = append(names, plan)
		}
		sort.Strings(names)
		label += "（" + strings.Join(names, "、") + "）"
	}
	return label
}

func magpieProviderSubtitle(host string, models int, accounts []magpieProviderAccount) string {
	parts := []string{}
	if host != "" {
		parts = append(parts, host)
	}
	if models > 0 {
		parts = append(parts, strconv.Itoa(models)+" 个模型")
	}
	if summary := magpieAccountSummary(accounts); summary != "" {
		parts = append(parts, summary)
	}
	if len(parts) == 0 {
		return "未登记端点"
	}
	return strings.Join(parts, " · ")
}

func parseMagpieProviders(payload []byte) ([]providerEntry, map[string]bool, magpieProvidersPayload, error) {
	var shaped magpieProvidersPayload
	if err := json.Unmarshal(payload, &shaped); err != nil {
		return nil, nil, shaped, err
	}
	entries := make([]providerEntry, 0, len(shaped.Providers))
	enabled := map[string]bool{}
	for _, provider := range shaped.Providers {
		if provider.ID == "" {
			continue
		}
		host := strings.TrimSpace(provider.Host)
		if host == "" {
			host = provider.ID
		}
		entries = append(entries, providerEntry{
			ID: provider.ID, Label: provider.Label, Badge: provider.Badge,
			Subtitle: magpieProviderSubtitle(host, shaped.Models[provider.ID], provider.Accounts),
			Models:   shaped.Models[provider.ID],
			Facts:    providerFacts{Configured: provider.Configured},
			Accounts: provider.Accounts,
			Quota:    magpieQuotaSummary(provider.Quotas),
			Off:      provider.Off,
		})
		enabled[provider.ID] = provider.Configured && !provider.Off
	}
	sort.SliceStable(entries, func(a, b int) bool { return entries[a].Label < entries[b].Label })
	return entries, enabled, shaped, nil
}
