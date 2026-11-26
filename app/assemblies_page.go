package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func assemblyModeLabel(mode string) string {
	if mode == "main" {
		return "主 Agent"
	}
	return "子 Agent"
}

func assemblyStatusLabel(row assemblyRow) string {
	if row.status == "valid" {
		return "可用"
	}
	return "有问题"
}

func assemblyDefinition(row assemblyRow) string {
	if row.definition != "" {
		return row.definition
	}
	return "未编译"
}

func (s *assemblyState) listView(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	if skeletonLoadingStatus(s.status) {
		skeletonAssembliesPage(ctx)
		return
	}
	ui.Column(ctx).FillWidth().Padding(th.Space(5), th.Space(6), th.Space(4), th.Space(6)).
		Gap(th.Space(3)).Children(func() {
		if s.status != "" {
			kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted)
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, "使用", t.Text.Sm).TextColor(t.Muted)
			kit.Text(ctx, "/", t.Text.Sm).TextColor(t.Muted)
			kit.Text(ctx, "能力装配", t.Text.Sm).TextColor(t.Foreground)
			ui.Spacer(ctx)
			if kit.Button(ctx, "打开装配文件", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm, Icon: iconFolder}).Clicked() {
				s.openFile()
			}
			if kit.Button(ctx, "刷新", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm, Icon: iconRefresh}).Clicked() {
				// load writes the rows the page is reading, so it runs where the
				// renderer owns them instead of on a bare goroutine.
				onUI(s.window, s.load)
			}
		})
		kit.Text(ctx, "把资源库里的技能、指令、MCP 与 Pi 扩展装配成 Agent 角色；编译后得到可被节点引用的 definition。",
			t.Text.Sm).TextColor(t.Muted)
		s.assemblyMeta(ctx, t)
		if len(s.rows) == 0 {
			kit.Text(ctx, "还没有装配。", t.Text.Sm).TextColor(t.Muted)
			return
		}
		card := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
		card.Children(func() {
			for index, row := range s.rows {
				s.assemblyRow(ctx, t, row, index == len(s.rows)-1)
			}
		})
	})
}

func (s *assemblyState) assemblyMeta(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Wrap().Children(func() {
		ui.Icon(ctx, iconDoc).Size(12, 12).TextColor(t.Muted)
		file := s.file
		if file == "" {
			file = "（未知位置）"
		}
		kit.Text(ctx, shortPath(file), t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine().Ellipsis("…")
		if s.fileError != "" {
			kit.Text(ctx, s.fileError, t.Text.Xs).TextColor(t.Danger).SingleLine().Ellipsis("…")
		}
	})
}

func shortPath(path string) string {
	if index := strings.LastIndex(path, "/"); index >= 0 && index < len(path)-1 {
		head := path[:index]
		if last := strings.LastIndex(head, "/"); last >= 0 {
			return "…" + head[last:] + "/" + path[index+1:]
		}
	}
	return path
}

func (s *assemblyState) assemblyRow(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow, last bool) {
	th := ctx.Theme()
	item := ui.Row(ctx).FillWidth().Padding(th.Space(2.5), th.Space(3)).Gap(th.Space(2.5)).
		AlignItems(ui.Center).Label("装配 " + row.name).Focusable()
	if item.Hovered() {
		item.Background(t.Hover)
	}
	item.OnClick(func() { s.selectAssembly(row.id) })
	item.Children(func() {
		glyph := ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Sm).Background(t.Hover).Center()
		glyph.Children(func() {
			ui.Icon(ctx, iconNetwork).Size(15, 15).TextColor(t.Muted)
		})
		ui.Column(ctx).Grow(1).Shrink(1).Gap(2).Children(func() {
			ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.name, t.Text.Sm).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				kit.Text(ctx, row.id, 10.5).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine()
				s.assemblyBadge(ctx, t, assemblyModeLabel(row.mode))
				if row.status != "" {
					s.assemblyBadge(ctx, t, assemblyStatusLabel(row))
				}
			})
			kit.Text(ctx, row.description, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		})
		kit.Text(ctx, strconv.Itoa(len(row.resources))+" 个资源", t.Text.Xs).TextColor(t.Muted).SingleLine()
		kit.Text(ctx, row.definition, 11).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine().Ellipsis("…").MaxWidth(150)
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
	}
}

func (s *assemblyState) assemblyBadge(ctx *ui.Context, t gwtheme.Tokens, label string) {
	badge := ui.Row(ctx).PaddingX(6).PaddingY(1).Radius(4).Background(t.Hover)
	badge.Children(func() {
		kit.Text(ctx, label, 9.5).TextColor(t.Muted).SingleLine()
	})
}

func (s *assemblyState) view(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	if row := s.selectedRow(); row != nil {
		s.detailView(ctx, t, *row)
		return
	}
	s.listView(ctx, t)
}
