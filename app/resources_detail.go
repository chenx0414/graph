package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *resourceState) fieldIsFilled(row resourceRow, env string) bool {
	if _, ok := s.saved[env]; ok {
		return true
	}
	for _, configured := range row.configured {
		if configured == env {
			return true
		}
	}
	return false
}

func (s *resourceState) detailHeader(ctx *ui.Context, t gwtheme.Tokens, row resourceRow) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
		glyph := ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Sm).Background(t.Hover).Center()
		glyph.Children(func() {
			ui.Icon(ctx, resourceKindIcon(row.kind)).Size(16, 16).TextColor(t.Muted)
		})
		ui.Column(ctx).Grow(1).Shrink(1).Gap(2).Children(func() {
			ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.name, t.Text.Lg).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(6).PaddingY(1).Radius(4).Background(t.Hover)
				badge.Children(func() {
					kit.Text(ctx, resourceKindLabel(row.kind), 9.5).TextColor(t.Muted).SingleLine()
				})
				if row.version != "" {
					kit.Text(ctx, "v"+row.version, t.Text.Xs).TextColor(t.Muted).SingleLine()
				}
			})
			if row.repo != "" {
				kit.Text(ctx, row.repo, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
		if kit.IconButton(ctx, iconClose, "关闭资源详情", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.selected = ""
			s.frame()
		}
	})
}

func (s *resourceState) detailBody(ctx *ui.Context, t gwtheme.Tokens, row resourceRow) {
	th := ctx.Theme()
	if row.description != "" {
		kit.Text(ctx, row.description, t.Text.Sm).TextColor(t.Foreground).MaxLines(4)
	}
	if row.err != "" {
		kit.Text(ctx, "加载失败："+row.err, t.Text.Xs).TextColor(t.Danger)
	}
	rows := []struct {
		label string
		value string
	}{
		{"来源", row.source},
		{"版本", row.version},
		{"状态", row.status},
	}
	if row.origin != "" {
		rows = append(rows, struct {
			label string
			value string
		}{"归属", resourceOriginLabel(row.origin)})
	}
	card := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
	card.Children(func() {
		for index, line := range rows {
			if line.value == "" {
				continue
			}
			if index > 0 {
				ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
			}
			ui.Row(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(3)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, line.label, t.Text.Xs).TextColor(t.Muted).Width(56)
				kit.Text(ctx, line.value, t.Text.Xs).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			})
		}
	})
	if len(row.fields) > 0 {
		kit.Text(ctx, "需要的字段", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		fields := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
		fields.Children(func() {
			for index, field := range row.fields {
				spec := field
				if index > 0 {
					ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
				}
				ui.Column(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(1.5)).Children(func() {
					filled := s.fieldIsFilled(row, spec.Env)
					ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
						kit.Text(ctx, spec.Env, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Foreground).Grow(1).SingleLine()
						state := "缺少"
						color := t.WarningText
						if filled {
							state, color = "已填写", t.SuccessText
						}
						kit.Text(ctx, state, t.Text.Xs).TextColor(color).SingleLine()
						if kit.Button(ctx, "填写", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
							s.draftEnv = spec.Env
							s.draftValue = ""
							s.frame()
						}
						if filled && kit.Button(ctx, "撤销", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
							s.revokeEnv(spec.Env)
						}
					})
					if spec.Reason != "" {
						kit.Text(ctx, spec.Reason, 11).TextColor(t.Muted).SingleLine().Ellipsis("…")
					}
					if s.draftEnv != spec.Env {
						return
					}
					input := kit.Input(ctx, &s.draftValue, kit.InputOpts{Placeholder: "粘贴 " + spec.Env + " 的值…"})
					input.FillWidth()
					if spec.Secret {
						input.Password()
					}
					ui.Row(ctx).Gap(th.Space(1.5)).Children(func() {
						if kit.Button(ctx, "保存", kit.ButtonOpts{Variant: kit.Default, Size: kit.SizeSm}).Clicked() {
							go s.saveEnv()
						}
						if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
							s.draftEnv = ""
							s.draftValue = ""
							s.frame()
						}
					})
				})
			}
		})
	}
	ui.Row(ctx).Gap(th.Space(1.5)).Children(func() {
		if kit.Button(ctx, "打开目录", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
			go s.openSource(row)
		}
		if row.repo != "" {
			if kit.Button(ctx, "复制仓库地址", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				copyMessage("https://github.com/" + row.repo)
			}
		}
	})
}

func resourceOriginLabel(origin string) string {
	switch origin {
	case "agent":
		return "Agent 私有目录"
	case "project":
		return "项目目录"
	case "library":
		return "资源库"
	case "global":
		return "全局目录"
	}
	return origin
}

func (s *resourceState) detailView(ctx *ui.Context, t gwtheme.Tokens, row resourceRow) {
	th := ctx.Theme()
	ui.Column(ctx).FillWidth().Padding(th.Space(5), th.Space(6), th.Space(4), th.Space(6)).
		Gap(th.Space(3)).Children(func() {
		if s.status != "" {
			kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted)
		}
		s.detailHeader(ctx, t, row)
		s.detailBody(ctx, t, row)
	})
}

func resourceHaystack(row resourceRow) string {
	return strings.ToLower(row.name + " " + row.id + " " + row.description + " " + row.repo + " " + row.source)
}
