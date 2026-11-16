package main

import (
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
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
	Models   int
	Facts    providerFacts
	Accounts []magpieProviderAccount
	Quota    string
	Off      bool
}

type providersPageState struct {
	loading         bool
	attempted       bool
	failed          string
	entries         []providerEntry
	search          string
	packageAccounts bool
	enabled         map[string]bool
	source          magpieProvidersPayload
	notice          string
	openPath        func(string) error
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
		return true
	}
	if enabled, known := s.providers.enabled[id]; known {
		return enabled
	}
	return true
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
	go func() {
		payload, err := api.get("/api/providers/magpie")
		var entries []providerEntry
		var enabled map[string]bool
		var source magpieProvidersPayload
		if err == nil {
			entries, enabled, source, err = parseMagpieProviders(payload)
			if err == nil && !source.Available && source.Error != "" {
				err = errStatus(source.Error)
			}
		}
		onUI(s.window, func() {
			s.providers.loading = false
			s.providers.attempted = true
			if err != nil {
				s.providers.failed = err.Error()
				s.providers.source = source
				s.frame()
				return
			}
			s.providers.failed = ""
			s.providers.entries = entries
			s.providers.enabled = enabled
			s.providers.source = source
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

func (s *shellState) providerSwitchState(ctx *ui.Context, entry providerEntry, pal magpiePalette) {
	enabled := s.providersEnabled(entry.ID)
	label := "在 Magpie 里开关 " + entry.Label
	pill := ui.Row(ctx).Height(19).PaddingX(7).Radius(10).Gap(6).AlignItems(ui.Center).Label(label)
	pill.Background(pal.Line)
	pill.Children(func() {
		dot := pal.Faint
		text := pal.Muted
		state := "关"
		if enabled {
			dot, text = pal.Green, pal.Mark
			state = "开"
		}
		ui.Box(ctx).Width(6).Height(6).Radius(10).Background(dot)
		kit.Text(ctx, "Magpie "+state, 10).TextColor(text).SingleLine()
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
		active.modelPicker.focus = true
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
		if entry.Quota != "" {
			kit.Text(ctx, entry.Quota, 11).TextColor(pal.Muted).SingleLine()
		}
		s.providerKeyPill(ctx, entry, pal)
		s.providerSwitchState(ctx, entry, pal)
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
	kit.Text(ctx, "在 Magpie 里添加账号", 11).TextColor(pal.Faint).SingleLine()
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
			if kit.Button(ctx, "打开 Magpie 配置", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				s.openMagpie()
			}
			if kit.IconButton(ctx, iconRefresh, "刷新供应商", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				s.refreshProviders()
			}
		})
		sources := "数据源 · Magpie"
		if dir := strings.TrimSpace(s.providers.source.Dir); dir != "" {
			sources += " · " + dir
		}
		ui.Row(ctx).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, sources, 11).TextColor(pal.Faint).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, "开关在 Magpie 里 · 改完点右上刷新", 11).TextColor(pal.Faint).SingleLine()
		})
		ui.Box(ctx).Height(10)
		phase := s.providersPhase()
		switch phase {
		case providersIdlePhase, providersLoadingPhase:
			skeletonProvidersPage(ctx)
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
		kit.Text(ctx, "供应商与账号都由 Magpie 管理 · 这里只读", 11).TextColor(pal.Faint).Padding(8, 2)
	})
}

func (s *shellState) openMagpie() {
	dir := strings.TrimSpace(s.providers.source.Dir)
	if dir == "" {
		return
	}
	open := s.providers.openPath
	if open == nil {
		open = mygo.Shell.OpenPath
	}
	_ = open(filepath.Join(dir, "providers.json"))
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
