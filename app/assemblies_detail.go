package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *assemblyState) detailView(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	ui.Column(ctx).FillWidth().Padding(th.Space(5), th.Space(6), th.Space(4), th.Space(6)).
		Gap(th.Space(3)).Children(func() {
		if s.status != "" {
			kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted)
		}
		s.detailHeader(ctx, t, row)
		if s.editorOpen {
			s.editorView(ctx, t)
			return
		}
		s.detailFacts(ctx, t, row)
		if !s.editingDescription {
			ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Start).Children(func() {
				kit.Text(ctx, row.description, t.Text.Sm).TextColor(t.Foreground).Grow(1).MaxLines(4)
				if kit.Button(ctx, "改描述", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
					s.draftDescription = row.description
					s.editingDescription = true
					s.frame()
				}
			})
		} else {
			s.draftRow(ctx, t)
		}
		s.resourcesHead(ctx, t, row)
		s.issuesList(ctx, t, row)
		ui.Row(ctx).Gap(th.Space(1.5)).Wrap().Children(func() {
			s.actionButtons(ctx, t, row)
		})
	})
}

func (s *assemblyState) detailHeader(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
		glyph := ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Sm).Background(t.Hover).Center()
		glyph.Children(func() {
			ui.Icon(ctx, iconNetwork).Size(16, 16).TextColor(t.Muted)
		})
		ui.Column(ctx).Grow(1).Shrink(1).Gap(2).Children(func() {
			ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.name, t.Text.Lg).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				kit.Text(ctx, row.id, 10.5).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine()
				s.assemblyBadge(ctx, t, assemblyModeLabel(row.mode))
				s.assemblyBadge(ctx, t, assemblyStatusLabel(row))
			})
			kit.Text(ctx, s.definitionLine(row), t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine()
		})
		if kit.IconButton(ctx, iconClose, "关闭装配详情", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.selected = ""
			s.frame()
		}
	})
}

func (s *assemblyState) definitionLine(row assemblyRow) string {
	if s.compiledVersion != "" {
		return "已编译 · " + s.compiledVersion
	}
	return "definition · " + assemblyDefinition(row)
}

func (s *assemblyState) detailFacts(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	lines := []struct{ label, value string }{
		{"装配 id", row.id},
		{"模式", assemblyModeLabel(row.mode)},
		{"资源", strconv.Itoa(len(row.resources)) + " 个 · 已解析 " + strconv.Itoa(len(row.resolved))},
		{"标签", strings.Join(row.tags, "、")},
	}
	card := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
	card.Children(func() {
		for index, line := range lines {
			if line.value == "" {
				continue
			}
			if index > 0 {
				ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
			}
			ui.Row(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(3)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, line.label, t.Text.Xs).TextColor(t.Muted).Width(64)
				kit.Text(ctx, line.value, t.Text.Xs).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			})
		}
	})
}

func (s *assemblyState) draftRow(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
		input := kit.Input(ctx, &s.draftDescription, kit.InputOpts{Placeholder: "描述这个 Agent 角色的职责…"})
		input.Grow(1)
		if kit.Button(ctx, "保存描述", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
			go s.saveDescription()
		}
		if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.editingDescription = false
			s.frame()
		}
	})
}

func (s *assemblyState) resourcesHead(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, "资源", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		kit.Text(ctx, "装配引用的资源与解析结果", t.Text.Xs).TextColor(t.Muted).Grow(1)
		label := "添加资源"
		if s.resourcePickerOpen {
			label = "收起资源库"
		}
		if kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.resourcePickerOpen = !s.resourcePickerOpen
			s.resourceQuery = ""
			s.frame()
		}
	})
	if s.resourcePickerOpen {
		s.resourcePicker(ctx, t, row)
	}
	card := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
	card.Children(func() {
		for index, member := range row.resources {
			if index > 0 {
				ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
			}
			s.resourceLine(ctx, t, row, member)
		}
		if len(row.resources) == 0 {
			ui.Box(ctx).FillWidth().Padding(th.Space(3)).Children(func() {
				kit.Text(ctx, "这个装配还没有引用任何资源。", t.Text.Xs).TextColor(t.Muted)
			})
		}
	})
}

func (s *assemblyState) resourceLine(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow, member assemblyResource) {
	th := ctx.Theme()
	resolved, ok := resolvedOf(row, member)
	line := ui.Row(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(2)).AlignItems(ui.Center)
	line.Children(func() {
		ui.Icon(ctx, resourceKindIcon(kindOf(resolved, ok))).Size(13, 13).TextColor(t.Muted)
		ui.Column(ctx).Grow(1).Shrink(1).Gap(1).Children(func() {
			ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				ref := member.ResourceID + "@" + versionOf(resolved, member)
				kit.Text(ctx, ref, t.Text.Sm).FontWeight(500).Font(gwtheme.MonoFont).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				if ok && resolved.Name != "" && resolved.Name != member.ResourceID {
					kit.Text(ctx, resolved.Name, 10.5).TextColor(t.Muted).SingleLine().Ellipsis("…")
				}
			})
			if ok && resolved.Name != "" {
				kit.Text(ctx, resourceKindLabel(resolved.Kind)+" · "+member.Role, t.Text.Xs).TextColor(t.Muted).SingleLine()
			} else {
				kit.Text(ctx, member.Role+" · 在资源库里找不到这个版本", t.Text.Xs).TextColor(t.Muted).SingleLine()
			}
		})
		if ok {
			kit.Text(ctx, "已解析", t.Text.Xs).TextColor(t.SuccessText).SingleLine()
		} else {
			kit.Text(ctx, "缺少", t.Text.Xs).TextColor(t.WarningText).SingleLine()
		}
		if kit.IconButton(ctx, iconClose, "移除 "+member.ResourceID, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			s.removeResource(row, member.ResourceID)
		}
	})
}

func resolvedOf(row assemblyRow, member assemblyResource) (assemblyResource, bool) {
	for _, resolved := range row.resolved {
		if resolved.ResourceID == member.ResourceID {
			return resolved, true
		}
	}
	return assemblyResource{}, false
}

func kindOf(resolved assemblyResource, ok bool) string {
	if ok {
		return resolved.Kind
	}
	return "skill"
}

func versionOf(resolved assemblyResource, member assemblyResource) string {
	if resolved.Version != "" {
		return resolved.Version
	}
	return member.Version
}

func (s *assemblyState) issuesList(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	if len(row.issues) == 0 {
		return
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
		ui.Icon(ctx, iconAlert).Size(13, 13).TextColor(t.WarningText)
		kit.Text(ctx, strconv.Itoa(len(row.issues))+" 个问题", t.Text.Sm).FontWeight(600).TextColor(t.WarningText)
	})
	for _, issue := range row.issues {
		kit.Text(ctx, issue, t.Text.Xs).TextColor(t.WarningText).MaxLines(2)
	}
}

func (s *assemblyState) actionButtons(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	if kit.Button(ctx, "编译", kit.ButtonOpts{Variant: kit.Default, Size: kit.SizeSm}).Clicked() {
		go s.compile()
	}
	if kit.Button(ctx, "复制为新装配", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
		s.duplicateAssembly(row.id)
	}
	if row.mode != "main" {
		label := "删除"
		if s.deleteArmed == row.id {
			label = "确认删除"
		}
		if kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.DestructiveOutline, Size: kit.SizeSm}).Clicked() {
			go s.deleteAssembly(row.id)
		}
	}
	if kit.Button(ctx, "打开装配文件", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
		s.openFile()
	}
}

func (s *assemblyState) editorView(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	kit.Text(ctx, "新建装配", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
	idInput := kit.Input(ctx, &s.editorID, kit.InputOpts{Placeholder: "id（小写字母、数字、连字符）"})
	idInput.FillWidth()
	nameInput := kit.Input(ctx, &s.editorName, kit.InputOpts{Placeholder: "名称"})
	nameInput.FillWidth()
	description := kit.Input(ctx, &s.editorDescription, kit.InputOpts{Placeholder: "描述"})
	description.FillWidth()
	if s.saveLabel != "" {
		kit.Text(ctx, "已编译 · "+s.saveLabel, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.SuccessText)
	}
	ui.Row(ctx).Gap(th.Space(1.5)).Children(func() {
		if kit.Button(ctx, "保存装配", kit.ButtonOpts{Variant: kit.Default, Size: kit.SizeSm}).Clicked() {
			go s.createAssembly()
		}
		if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.editorOpen = false
			s.frame()
		}
	})
}
