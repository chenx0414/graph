package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

type providerEntry struct {
	ID         string
	Label      string
	Badge      string
	Subtitle   string
	Status     string
	API        string
	Models     int
	Configured bool
}

type providersPayload struct {
	Platforms []struct {
		ID                   string `json:"id"`
		Label                string `json:"label"`
		API                  string `json:"api"`
		BaseURL              string `json:"baseUrl"`
		CredentialKind       string `json:"credentialKind"`
		CredentialConfigured bool   `json:"credentialConfigured"`
		Custom               bool   `json:"custom"`
	} `json:"platforms"`
	Credentials map[string]struct {
		DisplayName string `json:"displayName"`
		Resolved    bool   `json:"resolved"`
	} `json:"credentials"`
}

type providersPageState struct {
	loading         bool
	failed          string
	entries         []providerEntry
	search          string
	packageAccounts bool
	enabled         map[string]bool
	protocols       map[string][]string
}

func (s *shellState) providersEnabled(id string) bool {
	if s.providers.enabled == nil {
		return false
	}
	return s.providers.enabled[id]
}

func providerBadge(kind string, custom bool) string {
	switch {
	case custom:
		return "自建"
	case kind == "subscription":
		return "套餐"
	}
	return "按量付费"
}

func providerProtocols(api string) []string {
	switch api {
	case "anthropic-messages":
		return []string{"A"}
	case "openai-responses":
		return []string{"R"}
	}
	return []string{"O"}
}

func providerHost(baseURL string) string {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Hostname() == "" {
		return baseURL
	}
	return parsed.Hostname()
}

func parseProvidersPayload(payload []byte, models []modelChoice) ([]providerEntry, map[string]bool, error) {
	var shaped providersPayload
	if err := json.Unmarshal(payload, &shaped); err != nil {
		return nil, nil, err
	}
	counts := map[string]int{}
	for _, model := range models {
		counts[modelProviderID(model.id)]++
	}
	entries := make([]providerEntry, 0, len(shaped.Platforms))
	enabled := map[string]bool{}
	for _, platform := range shaped.Platforms {
		if platform.ID == "" {
			continue
		}
		subtitle := providerHost(platform.BaseURL) + " · " + strconv.Itoa(counts[platform.ID]) + " 个模型"
		configured := platform.CredentialConfigured
		status := "已连接"
		if !configured {
			status = "未配置"
		}
		entries = append(entries, providerEntry{
			ID: platform.ID, Label: platform.Label, Badge: providerBadge(platform.CredentialKind, platform.Custom),
			Subtitle: subtitle, Status: status, API: platform.API, Models: counts[platform.ID], Configured: configured,
		})
		enabled[platform.ID] = configured
	}
	sort.SliceStable(entries, func(a, b int) bool { return entries[a].Label < entries[b].Label })
	return entries, enabled, nil
}

func modelProviderID(id string) string {
	if index := strings.Index(id, ":"); index > 0 {
		return id[:index]
	}
	if index := strings.Index(id, "/"); index > 0 {
		return id[:index]
	}
	return id
}

func (s *shellState) ensureProviders() {
	if s.providers.loading || len(s.providers.entries) > 0 {
		return
	}
	s.providers.loading = true
	api := s.api
	var models []modelChoice
	if active := s.active(); active != nil {
		models = active.modelChoices()
	}
	go func() {
		if len(models) == 0 {
			if settingsPayload, err := api.get("/api/settings"); err == nil {
				var listed modelListPayload
				if json.Unmarshal(settingsPayload, &listed) == nil {
					for _, model := range listed.Models {
						if model.ID != "" {
							models = append(models, modelChoice{id: model.ID, thinking: model.DefaultThinkingLevel})
						}
					}
				}
			}
		}
		payload, err := api.get("/api/providers")
		var entries []providerEntry
		var enabled map[string]bool
		if err == nil {
			entries, enabled, err = parseProvidersPayload(payload, models)
		}
		onUI(s.window, func() {
			s.providers.loading = false
			if err != nil {
				s.providers.failed = err.Error()
				return
			}
			s.providers.entries = entries
			s.providers.enabled = enabled
			s.providers.protocols = map[string][]string{}
			for _, entry := range entries {
				s.providers.protocols[entry.ID] = providerProtocols(entry.API)
			}
			s.frame()
		})
	}()
}

func providerInitial(label string) string {
	for _, r := range label {
		if r == ' ' {
			continue
		}
		return strings.ToUpper(string(r))
	}
	return "?"
}

func providerTint(id string) ui.Color {
	colors := []ui.Color{palette.Indigo500.Color(), palette.Amber500.Color(), palette.Green500.Color(),
		palette.Purple500.Color(), palette.Blue500.Color(), palette.Teal500.Color()}
	sum := 0
	for _, r := range id {
		sum += int(r)
	}
	return colors[sum%len(colors)]
}

func (s *shellState) providerToggle(ctx *ui.Context, entry providerEntry, t gwtheme.Tokens) {
	enabled := s.providersEnabled(entry.ID)
	label := "停用 " + entry.Label
	if !enabled {
		label = "启用 " + entry.Label
	}
	track := ui.Box(ctx).Width(36).Height(20).Radius(t.Radius.Full).Label(label).Focusable()
	if enabled {
		track.Background(t.Primary)
	} else {
		track.Background(t.Input)
	}
	track.OnClick(func() {
		s.providers.enabled[entry.ID] = !enabled
		s.frame()
	})
	track.Children(func() {
		knob := ui.Box(ctx).Size(16, 16).Radius(t.Radius.Full).Background(t.Background)
		if enabled {
			knob.Translate(18, 2)
		} else {
			knob.Translate(2, 2)
		}
	})
}

func (s *shellState) providerRow(ctx *ui.Context, entry providerEntry, t gwtheme.Tokens, last bool) {
	status := entry.Status
	if entry.Configured && !s.providersEnabled(entry.ID) {
		status = "未启用"
	}
	row := ui.Row(ctx).FillWidth().Height(50).PaddingX(16).Gap(12).AlignItems(ui.Center).
		Label("用 " + entry.Label + " 的模型").Focusable()
	row.OnClick(func() {
		active := s.active()
		if active == nil {
			return
		}
		active.modelPicker.provider = entry.ID
		active.modelPicker.open = true
		active.modelPicker.active = 0
		active.modelPicker.showAll = false
		s.frame()
	})
	row.Children(func() {
		tile := ui.Box(ctx).Size(24, 24).Radius(t.Radius.Sm).Background(providerTint(entry.ID).Alpha(0.16)).Center()
		tile.Children(func() {
			kit.Text(ctx, providerInitial(entry.Label), t.Text.Xs).FontWeight(600).TextColor(providerTint(entry.ID))
		})
		ui.Column(ctx).Grow(1).Gap(2).Children(func() {
			ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, entry.Label, t.Text.Sm).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(6).PaddingY(1).Radius(t.Radius.Xs).Background(t.Hover)
				badge.Children(func() {
					kit.Text(ctx, entry.Badge, t.Text.Xs).TextColor(t.Muted).SingleLine()
				})
			})
			kit.Text(ctx, entry.Subtitle, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		})
		for _, protocol := range s.providers.protocols[entry.ID] {
			chip := ui.Box(ctx).Size(20, 20).Radius(t.Radius.Sm).Background(t.Hover).Center()
			chip.Children(func() {
				kit.Text(ctx, protocol, t.Text.Xs).TextColor(t.Muted).SingleLine()
			})
		}
		ui.Box(ctx).Width(6).Height(6).Radius(t.Radius.Full).
			Background(func() ui.Color {
				if entry.Configured && s.providersEnabled(entry.ID) {
					return palette.Green500.Color()
				}
				return t.Muted
			}())
		kit.Text(ctx, status, t.Text.Xs).TextColor(t.Muted).SingleLine().Width(52)
		s.providerToggle(ctx, entry, t)
		ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(gwtheme.Stroke).Background(t.Border)
	}
}

func (s *shellState) panelProviders(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	s.ensureProviders()
	ui.Column(ctx).FillWidth().Padding(16).Gap(12).Children(func() {
		head := ui.Row(ctx).FillWidth().Gap(8).AlignItems(ui.Center)
		head.Children(func() {
			kit.Text(ctx, "模型", t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, "/", t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, "供应商", t.Text.Xs).TextColor(t.Foreground).SingleLine()
			ui.Spacer(ctx)
			search := kit.Input(ctx, &s.providers.search, kit.InputOpts{Placeholder: "查找供应商"})
			search.Width(240)
			chip := ui.Row(ctx).PaddingX(10).PaddingY(6).Radius(t.Radius.Sm).Border(gwtheme.Hairline, t.Border).Gap(6).AlignItems(ui.Center)
			chip.Children(func() {
				kit.Text(ctx, "账号打包", t.Text.Xs).TextColor(t.Muted).SingleLine()
			})
		})
		if strings.TrimSpace(s.providers.search) != "" {
			query := strings.ToLower(strings.TrimSpace(s.providers.search))
			filtered := make([]providerEntry, 0, len(s.providers.entries))
			for _, entry := range s.providers.entries {
				if strings.Contains(strings.ToLower(entry.Label), query) || strings.Contains(strings.ToLower(entry.ID), query) {
					filtered = append(filtered, entry)
				}
			}
			s.providers.entries, filtered = filtered, s.providers.entries
			s.providerRowsCard(ctx, t)
			s.providers.entries = filtered
		} else {
			s.providerRowsCard(ctx, t)
		}
		foot := ui.Row(ctx).FillWidth().AlignItems(ui.Center)
		foot.Children(func() {
			kit.Text(ctx, "+ 添加供应商", t.Text.Xs).TextColor(t.Muted).SingleLine()
			ui.Spacer(ctx)
			if s.providers.failed != "" {
				kit.Text(ctx, "读不到供应商："+s.providers.failed, t.Text.Xs).TextColor(t.Danger).SingleLine().Ellipsis("…")
			}
		})
	})
}

func (s *shellState) providerRowsCard(ctx *ui.Context, t gwtheme.Tokens) {
	card := ui.Column(ctx).FillWidth().Background(t.Card).Radius(t.Radius.Md).
		Border(gwtheme.Hairline, t.Border).Clip()
	card.Children(func() {
		if len(s.providers.entries) == 0 {
			kit.Text(ctx, "没有匹配的供应商。", t.Text.Xs).TextColor(t.Muted).Padding(16, 16)
			return
		}
		for index, entry := range s.providers.entries {
			s.providerRow(ctx, entry, t, index == len(s.providers.entries)-1)
		}
	})
}
