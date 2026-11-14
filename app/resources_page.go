package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func resourceKindLabel(kind string) string {
	switch kind {
	case "skill":
		return "技能"
	case "prompt":
		return "指令"
	case "mcp":
		return "MCP 服务器"
	case "pi-extension":
		return "Pi 扩展"
	}
	return kind
}

func resourceKindIcon(kind string) *ui.SVG {
	switch kind {
	case "mcp":
		return iconDatabase
	case "prompt":
		return iconSpark
	case "pi-extension":
		return iconShare
	}
	return iconDoc
}

var resourceKindTabs = []struct {
	Key   string
	Label string
}{
	{"", "全部"},
	{"skill", "技能"},
	{"prompt", "指令"},
	{"mcp", "MCP 服务器"},
	{"pi-extension", "Pi 扩展"},
}

const resourceFoundPreview = 5

func (s *resourceState) filteredRows() []resourceRow {
	query := strings.ToLower(strings.TrimSpace(s.search))
	rows := make([]resourceRow, 0, len(s.rows))
	for _, row := range s.rows {
		if s.kind != "" && row.kind != s.kind {
			continue
		}
		if query != "" {
			haystack := strings.ToLower(row.name + " " + row.description + " " + row.repo + " " + row.source)
			if !strings.Contains(haystack, query) {
				continue
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func (s *resourceState) openSource(row resourceRow) {
	if row.source == "" || s.openPath == nil {
		s.status = "这条资源没有本地目录"
		s.frame()
		return
	}
	if err := s.openPath(row.source); err != nil {
		s.status = "打不开资源目录：" + err.Error()
		s.frame()
		return
	}
	s.status = ""
	s.frame()
}

func (s *resourceState) resourceHeader(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	title := "全部"
	for _, tab := range resourceKindTabs {
		if tab.Key == s.kind {
			title = tab.Label
		}
	}
	ui.Row(ctx).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, "使用", t.Text.Sm).TextColor(t.Muted)
		kit.Text(ctx, "/", t.Text.Sm).TextColor(t.Muted)
		kit.Text(ctx, "资源库", t.Text.Sm).TextColor(t.Muted)
		kit.Text(ctx, "/", t.Text.Sm).TextColor(t.Muted)
		kit.Text(ctx, title, t.Text.Sm).TextColor(t.Foreground)
		ui.Spacer(ctx)
		if kit.Button(ctx, "打开资源库文件夹", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm, Icon: iconFolder}).Clicked() {
			go s.openDirectory()
		}
		if kit.IconButton(ctx, iconRefresh, "刷新资源库", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			go s.refresh()
		}
		ui.Box(ctx).Width(th.Space(1))
	})
}

func (s *resourceState) resourceSearch(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	bar := ui.Row(ctx).FillWidth().Height(th.Space(9)).Radius(t.Radius.Md).Border(gwtheme.Stroke, t.Border).
		Background(t.Card).PaddingX(th.Space(3)).Gap(th.Space(2)).AlignItems(ui.Center)
	bar.Children(func() {
		ui.Icon(ctx, iconSearch).Size(14, 14).TextColor(t.Muted)
		field := kit.Input(ctx, &s.search, kit.InputOpts{Bare: true, Placeholder: "owner/repo、GitHub 或 GitLab 链接，或本机上的文件夹"})
		field.Grow(1).FontSize(t.Text.Sm)
	})
	if strings.TrimSpace(s.search) != "" {
		if kit.Button(ctx, "清除", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			s.search = ""
			s.frame()
		}
	}
}

func (s *resourceState) resourceTabs(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).Wrap().Children(func() {
		for _, tab := range resourceKindTabs {
			spec := tab
			active := s.kind == spec.Key
			label := spec.Label
			if spec.Key != "" {
				count := 0
				for _, row := range s.rows {
					if row.kind == spec.Key {
						count++
					}
				}
				label += " · " + strconv.Itoa(count)
			}
			pill := ui.Row(ctx).Height(th.Space(6)).PaddingX(th.Space(3)).Radius(t.Radius.Sm).
				AlignItems(ui.Center).Label("分类 " + spec.Label).Focusable()
			if active || pill.Hovered() {
				pill.Background(t.Hover)
			}
			pill.OnClick(func() {
				s.kind = spec.Key
				s.frame()
			})
			pill.Children(func() {
				color := t.Muted
				if active {
					color = t.Foreground
				}
				kit.Text(ctx, label, t.Text.Sm).TextColor(color).SingleLine()
			})
		}
	})
}

func (s *resourceState) sectionHead(ctx *ui.Context, t gwtheme.Tokens, label, note string) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, label, t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		kit.Text(ctx, note, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
	})
}

func (s *resourceState) resourceRow(ctx *ui.Context, t gwtheme.Tokens, row resourceRow, last bool) {
	th := ctx.Theme()
	item := ui.Row(ctx).FillWidth().Height(th.Space(13)).Padding(th.Space(2), th.Space(3), th.Space(2), th.Space(3)).
		Gap(th.Space(2.5)).AlignItems(ui.Center).Label("资源 " + row.name).Focusable()
	if item.Hovered() {
		item.Background(t.Hover)
	}
	item.Children(func() {
		glyph := ui.Box(ctx).Size(th.Space(6), th.Space(6)).Radius(t.Radius.Sm).Background(t.Hover).Center()
		glyph.Children(func() {
			ui.Icon(ctx, resourceKindIcon(row.kind)).Size(14, 14).TextColor(t.Muted)
		})
		ui.Column(ctx).Grow(1).Shrink(1).Gap(2).Children(func() {
			ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.name, t.Text.Sm).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(6).PaddingY(1).Radius(4).Background(t.Hover)
				badge.Children(func() {
					kit.Text(ctx, resourceKindLabel(row.kind), 9.5).TextColor(t.Muted).SingleLine()
				})
			})
			sub := row.description
			if sub == "" {
				sub = row.source
			}
			kit.Text(ctx, sub, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		})
		if len(row.missing) > 0 {
			kit.Text(ctx, "缺 "+strings.Join(row.missing, "、"), t.Text.Xs).TextColor(t.WarningText)
		} else if row.repo != "" {
			kit.Text(ctx, row.repo, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…").MaxWidth(160)
		}
		if kit.Button(ctx, "打开", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			go s.openSource(row)
		}
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
	}
}

func (s *resourceState) resourceCard(ctx *ui.Context, t gwtheme.Tokens, row resourceRow) {
	th := ctx.Theme()
	card := ui.Column(ctx).Width(th.Space(59)).Padding(th.Space(3)).Gap(th.Space(2)).
		Radius(t.Radius.Md).Border(gwtheme.Stroke, t.Border).Background(t.Card)
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(2.5)).AlignItems(ui.Center).Children(func() {
			glyph := ui.Box(ctx).Size(th.Space(6), th.Space(6)).Radius(t.Radius.Sm).Background(t.Hover).Center()
			glyph.Children(func() {
				ui.Icon(ctx, resourceKindIcon(row.kind)).Size(14, 14).TextColor(t.Muted)
			})
			ui.Column(ctx).Grow(1).Shrink(1).Gap(1).Children(func() {
				kit.Text(ctx, row.name, t.Text.Sm).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				meta := row.repo
				if meta == "" {
					meta = row.source
				}
				kit.Text(ctx, meta, 11).TextColor(t.Muted).SingleLine().Ellipsis("…")
			})
			if row.ready {
				ui.Icon(ctx, iconCheck).Size(12, 12).TextColor(t.Muted)
			}
		})
		desc := row.description
		if desc == "" {
			desc = "来自 " + resourceKindLabel(row.kind) + " 资源库"
		}
		kit.Text(ctx, desc, t.Text.Xs).TextColor(t.Muted).MaxLines(3)
		ui.Row(ctx).FillWidth().AlignItems(ui.Center).Children(func() {
			if len(row.missing) > 0 {
				kit.Text(ctx, "缺 "+strings.Join(row.missing, "、"), 11).TextColor(t.WarningText).Grow(1).SingleLine().Ellipsis("…")
			} else {
				kit.Text(ctx, "v"+row.version, 11).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			}
			if kit.Button(ctx, "打开", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
				go s.openSource(row)
			}
		})
	})
}

func (s *resourceState) view(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	rows := s.filteredRows()
	found := make([]resourceRow, 0, len(rows))
	discovered := make([]resourceRow, 0, len(rows))
	for _, row := range rows {
		if row.origin == "agent" || row.origin == "project" {
			found = append(found, row)
			continue
		}
		discovered = append(discovered, row)
	}
	ui.Column(ctx).FillWidth().Padding(th.Space(5), th.Space(6), th.Space(4), th.Space(6)).
		Gap(th.Space(3)).Children(func() {
		if s.status != "" {
			kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted)
		}
		s.resourceHeader(ctx, t)
		s.resourceSearch(ctx, t)
		s.resourceTabs(ctx, t)
		if len(found) > 0 {
			s.sectionHead(ctx, t, "AGENT 中已有", "不在资源库中 — 来自各 Agent 自己的目录")
			card := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).
				Background(t.Card).Clip()
			card.Children(func() {
				shown := found
				if !s.showAllFound && len(shown) > resourceFoundPreview {
					shown = shown[:resourceFoundPreview]
				}
				for index, row := range shown {
					s.resourceRow(ctx, t, row, index == len(shown)-1)
				}
				if len(found) > resourceFoundPreview {
					more := ui.Row(ctx).FillWidth().Height(th.Space(9)).PaddingX(th.Space(3)).
						AlignItems(ui.Center).Label("展开 AGENT 中已有的全部资源").Focusable()
					if more.Hovered() {
						more.Background(t.Hover)
					}
					more.OnClick(func() {
						s.showAllFound = !s.showAllFound
						s.frame()
					})
					more.Children(func() {
						label := "显示全部 " + strconv.Itoa(len(found)) + " 个"
						if s.showAllFound {
							label = "收起"
						}
						kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted)
					})
				}
			})
		}
		s.sectionHead(ctx, t, "发现", "资源库 · "+strconv.Itoa(len(discovered))+" 个")
		grid := ui.Row(ctx).FillWidth().Wrap().Gap(th.Space(2.5))
		grid.Children(func() {
			for _, row := range discovered {
				s.resourceCard(ctx, t, row)
			}
		})
	})
}
