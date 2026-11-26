package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) nativeProviderRow(ctx *ui.Context, row nativeProviderRow, pal magpiePalette, last bool) {
	label := "编辑 " + row.Label
	element := ui.Row(ctx).FillWidth().Height(48).Padding(7, 12, 7, 14).Gap(12).AlignItems(ui.Center).
		Label(label).Focusable()
	if element.Hovered() {
		element.Background(pal.Card2)
	}
	element.OnClick(func() { s.editProvider(row.ID) })
	element.Children(func() {
		handle := ui.Box(ctx).Size(28, 28).Radius(6).Center()
		if icon := providerBrandIcon(row.ID); icon != nil {
			handle.Children(func() {
				ui.Icon(ctx, icon).Size(22, 22).TextColor(pal.Foreground)
			})
		} else {
			tint := providerTint(row.ID)
			handle.Background(tint.Alpha(0.14))
			handle.Children(func() {
				kit.Text(ctx, providerInitial(row.Label), 12).FontWeight(600).TextColor(tint)
			})
		}
		ui.Column(ctx).Grow(1).Gap(1).Children(func() {
			ui.Row(ctx).Gap(6).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.Label, 13).FontWeight(500).LetterSpacing(-0.06).TextColor(pal.Foreground).
					SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(5).PaddingY(1).Radius(4).Background(pal.Pill).AlignItems(ui.Center)
				badge.Children(func() {
					kit.Text(ctx, s.platformLabel(row.Platform), 9.5).FontWeight(600).LetterSpacing(0.2).TextColor(pal.Muted).SingleLine()
				})
			})
			kit.Text(ctx, providerHost(row.BaseURL)+" · "+strconv.Itoa(len(row.Models))+" 个模型", 11.5).TextColor(pal.Muted).SingleLine().Ellipsis("…")
		})
		state := "已配置"
		dot, text := pal.Green, pal.Mark
		if !row.Configured {
			state = "未配置"
			dot, text = pal.Amber, pal.Amber
		}
		pill := ui.Row(ctx).Width(128).Height(22).Radius(6).PaddingX(8).Gap(6).AlignItems(ui.Center)
		if !row.Configured {
			pill.Background(pal.AmberSoft)
		}
		pill.Children(func() {
			ui.Box(ctx).Width(6).Height(6).Radius(10).Background(dot)
			kit.Text(ctx, state, 11).TextColor(text).SingleLine()
		})
		if kit.Button(ctx, "用它", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Label("用 " + row.Label + " 的模型").Clicked() {
			s.openProviderPicker(row.ID)
		}
		ui.Icon(ctx, iconChevron).Size(11, 11).TextColor(pal.Faint)
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(1).Background(pal.Line2)
	}
}

func (s *shellState) nativeProvidersCard(ctx *ui.Context, pal magpiePalette) {
	card := ui.Column(ctx).FillWidth().Background(pal.Card).Radius(12).
		Border(gwtheme.Stroke, pal.Line).Clip()
	card.Children(func() {
		if len(s.providers.native) == 0 {
			kit.Text(ctx, "还没有本机供应商。点右上角「添加供应商」开始。", 13).TextColor(pal.Muted).Padding(18, 2)
			return
		}
		for index, row := range s.providers.native {
			s.nativeProviderRow(ctx, row, pal, index == len(s.providers.native)-1)
		}
	})
}

func (s *shellState) providerEditorForm(ctx *ui.Context, pal magpiePalette) {
	editing := s.providers.editing != ""
	title := "添加供应商"
	if editing {
		title = "编辑 " + s.providers.draft.Name
	}
	card := ui.Column(ctx).FillWidth().Gap(10).Padding(14).Background(pal.Card2).Radius(12).
		Border(gwtheme.Stroke, pal.Line)
	card.Children(func() {
		ui.Row(ctx).FillWidth().AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, title, 13).FontWeight(600).TextColor(pal.Foreground).Grow(1)
			if editing {
				label := "移除供应商"
				if s.providers.removeArmed {
					label = "确认移除"
				}
				if kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.DestructiveOutline, Size: kit.SizeSm}).Clicked() {
					if s.providers.removeArmed {
						// The document it rewrites belongs to the shell's writer, and
						// the request it sends leaves that writer afterwards.
						onUI(s.window, func() { s.removeProvider(s.providers.editing) })
					} else {
						s.providers.removeArmed = true
						s.frame()
					}
				}
			}
			if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				s.closeProviderEditor()
			}
			if kit.Button(ctx, "保存供应商", kit.ButtonOpts{Variant: kit.Default, Size: kit.SizeSm}).Clicked() {
				onUI(s.window, s.saveProvider)
			}
		})
		if !editing {
			ui.Row(ctx).FillWidth().Wrap().Gap(2).Children(func() {
				for _, preset := range s.providers.platforms {
					if preset.CredentialKind != "" && preset.CredentialKind != "api-key" {
						continue
					}
					s.platformTile(ctx, preset, pal)
				}
			})
		}
		name := kit.Input(ctx, &s.providers.draft.Name, kit.InputOpts{Placeholder: "供应商名称"})
		name.FillWidth().Label("供应商名称")
		baseURL := kit.Input(ctx, &s.providers.draft.BaseURL, kit.InputOpts{Placeholder: "接口地址，例如 https://api.openai.com/v1"})
		baseURL.FillWidth().Label("接口地址")
		keyHint := "API Key"
		if editing {
			keyHint = "API Key（留空则不改）"
		}
		key := kit.Input(ctx, &s.providers.draft.APIKey, kit.InputOpts{Placeholder: keyHint, Password: true})
		key.FillWidth().Label("API Key")
		models := kit.Input(ctx, &s.providers.draft.Models, kit.InputOpts{Placeholder: "模型 id，用逗号分隔"})
		models.FillWidth().Label("模型列表")
		if s.providers.saveFailed != "" {
			kit.Text(ctx, s.providers.saveFailed, 12).TextColor(pal.Amber)
		}
		kit.Text(ctx, "模型 id 原样发给该平台；上下文窗口与最大输出按 128k / 8k 写入，可在配置里改。", 11).TextColor(pal.Faint)
	})
}

func providerHost(raw string) string {
	value := strings.TrimSpace(raw)
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(value, prefix) {
			value = strings.TrimPrefix(value, prefix)
			break
		}
	}
	if slash := strings.IndexByte(value, '/'); slash >= 0 {
		value = value[:slash]
	}
	if value == "" {
		return raw
	}
	return value
}

func (s *shellState) platformTile(ctx *ui.Context, preset platformPreset, pal magpiePalette) {
	selected := s.providers.draft.Platform == preset.ID
	tile := ui.Row(ctx).Width(196).Height(34).Padding(0, 8).Gap(10).AlignItems(ui.Center).
		Radius(8).Label(preset.Label).Focusable()
	if selected {
		tile.Background(pal.Pill)
	} else if tile.Hovered() {
		tile.Background(pal.Card)
	}
	tile.OnClick(func() {
		s.providers.draft.Platform = preset.ID
		if preset.BaseURL != "" {
			s.providers.draft.BaseURL = preset.BaseURL
		}
		s.frame()
	})
	tile.Children(func() {
		if icon := providerBrandIcon(preset.ID); icon != nil {
			ui.Icon(ctx, icon).Size(18, 18).TextColor(pal.Foreground)
		} else {
			tint := providerTint(preset.ID)
			ui.Box(ctx).Size(18, 18).Radius(5).Center().Background(tint.Alpha(0.14)).Children(func() {
				kit.Text(ctx, providerInitial(preset.Label), 10).FontWeight(600).TextColor(tint)
			})
		}
		kit.Text(ctx, preset.Label, 13).TextColor(pal.Foreground).SingleLine().Ellipsis("…")
	})
}
