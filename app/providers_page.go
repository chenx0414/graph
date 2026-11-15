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
	ID       string
	Label    string
	Badge    string
	Subtitle string
	API      string
	Models   int
	Facts    providerFacts
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
	attempted       bool
	failed          string
	entries         []providerEntry
	search          string
	packageAccounts bool
	enabled         map[string]bool
	protocols       map[string][]string
}

func (s *shellState) providerStateOf(id string) providerState {
	for _, entry := range s.providers.entries {
		if entry.ID != id {
			continue
		}
		return providerStateOf(entry.Facts, s.providersEnabled(id))
	}
	return providerUnconfigured
}

func (s *shellState) providersPhase() providersPhase {
	return providersPhaseOf(s.providers.loading, s.providers.attempted, s.providers.failed, len(s.providers.entries))
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
		facts := providerFacts{Configured: platform.CredentialConfigured}
		if credential, ok := shaped.Credentials[platform.ID]; ok {
			resolved := credential.Resolved
			facts.Resolved = &resolved
		}
		entries = append(entries, providerEntry{
			ID: platform.ID, Label: platform.Label, Badge: providerBadge(platform.CredentialKind, platform.Custom),
			Subtitle: subtitle, API: platform.API, Models: counts[platform.ID], Facts: facts,
		})
		enabled[platform.ID] = platform.CredentialConfigured
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
	if s.providersPhase() != providersIdlePhase {
		return
	}
	s.loadProviders()
}

func (s *shellState) refreshProviders() {
	if s.providers.loading {
		return
	}
	s.providers.failed = ""
	s.loadProviders()
}

func (s *shellState) loadProviders() {
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
			s.providers.attempted = true
			if err != nil {
				s.providers.failed = err.Error()
				s.frame()
				return
			}
			s.providers.failed = ""
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

func (s *shellState) providerToggle(ctx *ui.Context, entry providerEntry, pal magpiePalette) {
	enabled := s.providersEnabled(entry.ID)
	label := "停用 " + entry.Label
	if !enabled {
		label = "启用 " + entry.Label
	}
	track := ui.Box(ctx).Width(32).Height(19).Radius(10).Label(label).Focusable()
	if enabled {
		track.Background(pal.Mark)
	} else {
		track.Background(pal.Line)
	}
	track.OnClick(func() {
		s.providers.enabled[entry.ID] = !enabled
		s.frame()
	})
	track.Children(func() {
		knob := ui.Box(ctx).Size(15, 15).Radius(10).Background(pal.Card)
		if enabled {
			knob.Translate(15, 2)
		} else {
			knob.Translate(2, 2)
		}
	})
}

func (s *shellState) providerKeyPill(ctx *ui.Context, entry providerEntry, pal magpiePalette) {
	state := s.providerStateOf(entry.ID)
	pill := ui.Row(ctx).Width(128).Height(22).Radius(6).PaddingX(8).Gap(6).AlignItems(ui.Center)
	dot := pal.Green
	text := pal.Muted
	switch state.Severity() {
	case providerAttention:
		pill.Background(pal.AmberSoft)
		dot, text = pal.Amber, pal.Amber
	case providerQuiet:
		pill.Opacity(0.45)
		dot, text = pal.Faint, pal.Muted
	}
	pill.Children(func() {
		ui.Box(ctx).Width(6).Height(6).Radius(10).Background(dot)
		kit.Text(ctx, state.Label(), 11).TextColor(text).SingleLine().Ellipsis("…").Grow(1)
	})
}

func (s *shellState) providerHandle(ctx *ui.Context, entry providerEntry, pal magpiePalette) {
	handle := ui.Box(ctx).Size(28, 28).Radius(6).Center()
	if icon := providerBrandIcon(entry.ID); icon != nil {
		handle.Children(func() {
			ui.Icon(ctx, icon).Size(22, 22).TextColor(pal.Foreground)
		})
		return
	}
	tint := providerTint(entry.ID)
	handle.Background(tint.Alpha(0.14))
	handle.Children(func() {
		kit.Text(ctx, providerInitial(entry.Label), 12).FontWeight(600).TextColor(tint)
	})
}

func (s *shellState) providerRow(ctx *ui.Context, entry providerEntry, pal magpiePalette, last bool) {
	row := ui.Row(ctx).FillWidth().Height(48).Padding(7, 12, 7, 14).Gap(12).AlignItems(ui.Center).
		Label("用 " + entry.Label + " 的模型").Focusable()
	if row.Hovered() {
		row.Background(pal.Card2)
	}
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
		s.providerHandle(ctx, entry, pal)
		ui.Column(ctx).Grow(1).Gap(1).Children(func() {
			ui.Row(ctx).Gap(6).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, entry.Label, 13).FontWeight(500).LetterSpacing(-0.06).TextColor(pal.Foreground).
					SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(5).PaddingY(1).Radius(4).Background(pal.Pill).AlignItems(ui.Center)
				badge.Children(func() {
					kit.Text(ctx, entry.Badge, 9.5).FontWeight(600).LetterSpacing(0.2).TextColor(pal.Muted).SingleLine()
				})
			})
			kit.Text(ctx, entry.Subtitle, 11.5).TextColor(pal.Muted).SingleLine().Ellipsis("…")
		})
		for _, protocol := range s.providers.protocols[entry.ID] {
			chip := ui.Box(ctx).Size(26, 26).Radius(8).Background(pal.Pill).Border(gwtheme.Stroke, pal.Line2).Center()
			chip.Children(func() {
				kit.Text(ctx, protocol, 11).TextColor(pal.Muted).SingleLine()
			})
		}
		s.providerKeyPill(ctx, entry, pal)
		s.providerToggle(ctx, entry, pal)
		ui.Icon(ctx, iconChevron).Size(11, 11).TextColor(pal.Faint)
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(1).Background(pal.Line2)
	}
}
func (s *shellState) providerRowsCard(ctx *ui.Context, pal magpiePalette, entries []providerEntry) {
	card := ui.Column(ctx).FillWidth().Background(pal.Card).Radius(12).
		Border(gwtheme.Stroke, pal.Line).Clip()
	card.Children(func() {
		if len(entries) == 0 {
			kit.Text(ctx, providersEmptyPhase.Message(strings.TrimSpace(s.providers.search)), 13).TextColor(pal.Muted).Padding(18, 2)
			return
		}
		for index, entry := range entries {
			s.providerRow(ctx, entry, pal, index == len(entries)-1)
		}
	})
}

func (s *shellState) providerSearch(ctx *ui.Context, pal magpiePalette) {
	field := ui.TextInputBase(ctx, &s.providers.search)
	field.Width(220).Height(26).PaddingX(9).Radius(7).Border(gwtheme.Stroke, pal.Line).
		Background(pal.Card).FontSize(12).Placeholder("查找供应商").Label("查找供应商").FocusRing(false)
	chip := ui.Row(ctx).Height(26).PaddingX(9).Radius(7).Border(gwtheme.Stroke, pal.Line).
		Background(pal.Card).Gap(6).AlignItems(ui.Center).Label("账号打包").Focusable()
	chip.Children(func() {
		ui.Icon(ctx, iconEye).Size(14, 14).TextColor(pal.Muted)
		kit.Text(ctx, "账号打包", 12).TextColor(pal.Muted).SingleLine()
	})
}

func (s *shellState) panelProviders(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	pal := magpiePaletteFor(t.Dark)
	s.ensureProviders()
	page := ui.Column(ctx).FillWidth().Padding(2, 16, 8, 16)
	page.Children(func() {
		head := ui.Row(ctx).FillWidth().Gap(8).AlignItems(ui.Center)
		head.Children(func() {
			kit.Text(ctx, "模型", 12).TextColor(pal.Muted).SingleLine()
			kit.Text(ctx, "/", 12).TextColor(pal.Muted).SingleLine()
			kit.Text(ctx, "供应商", 12).TextColor(pal.Foreground2).SingleLine()
			ui.Spacer(ctx)
			s.providerSearch(ctx, pal)
		})
		ui.Box(ctx).Height(10)
		phase := s.providersPhase()
		switch phase {
		case providersIdlePhase, providersLoadingPhase:
			kit.Text(ctx, phase.Message(""), 13).TextColor(pal.Muted).Padding(18, 2)
		case providersFailedPhase:
			s.providerFailure(ctx, pal)
		case providersEmptyPhase:
			s.providerRowsCard(ctx, pal, nil)
		default:
			s.providerRowsCard(ctx, pal, providersMatching(s.providers.entries, strings.ToLower(strings.TrimSpace(s.providers.search))))
			if s.providers.failed != "" {
				kit.Text(ctx, "读不到供应商："+s.providers.failed, 12).TextColor(pal.Amber)
			}
		}
		add := ui.Row(ctx).Padding(8, 2).AlignItems(ui.Center)
		add.Children(func() {
			kit.Text(ctx, "＋ 添加供应商", 13).TextColor(pal.Muted).SingleLine()
		})
	})
}

func (s *shellState) providerFailure(ctx *ui.Context, pal magpiePalette) {
	ui.Column(ctx).FillWidth().Gap(8).Padding(18, 2).Children(func() {
		kit.Text(ctx, "读不到供应商："+s.providers.failed, 13).TextColor(pal.Amber)
		ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
			kit.Button(ctx, "重试供应商", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).
				Label("重试供应商").OnClick(func() { s.refreshProviders() })
		})
	})
}
