package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type railItem struct {
	kind  string
	label string
	icon  *ui.SVG
}

var railItems = []railItem{
	{"overview", "概览", iconHome},
	{"conversation", "对话", iconChat},
	{"history", "历史", iconClock},
	{"tasks", "任务", iconDoc},
	{"graph", "图谱", iconGraph},
	{"capabilities", "能力", iconShare},
	{"settings", "设置", iconGear},
}

var boardModules = []string{"overview", "conversation", "history", "tasks", "graph", "artifacts", "models", "questions", "capabilities", "settings"}

type boardState struct {
	panels   []boardPanel
	path     string
	grid     bool
	search   bool
	focus    bool
	adding   bool
	lastKind string
	query    string
}

func (s *shellState) whiteboard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	card := ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Background(t.Window).
		Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Clip()
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		if !s.board.grid {
			return
		}
		p.Clip(r, t.Radius.Xl, func() {
			drawBoardGrid(p, r, t.Grid)
		})
	})
	card.Children(func() {
		if expanded := s.expandedPanel(); expanded != nil {
			s.boardPanelView(ctx, expanded, true)
		} else {
			width, height := s.canvasSize()
			ui.ScrollBoth(ctx).Fill().Children(func() {
				ui.Box(ctx).Width(width).Height(height).Children(func() {
					for index := range s.board.panels {
						s.boardPanelView(ctx, &s.board.panels[index], false)
					}
				})
			})
		}
		s.boardToolbar(ctx)
	})
}

func drawBoardGrid(p *ui.Painter, r ui.Rect, color ui.Color) {
	const step, size = float32(26), float32(2)
	for x := r.X + 13; x < r.X+r.W; x += step {
		for y := r.Y + 13; y < r.Y+r.H; y += step {
			p.Fill(ui.Rect{X: x - size/2, Y: y - size/2, W: size, H: size}, color, 0)
		}
	}
}

func (s *shellState) boardToolbar(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Row(ctx).Attach(ui.AnchorTopRight, ui.AnchorTopRight).Top(th.Space(3)).Right(th.Space(3)).
		Padding(th.Space(0.5)).Gap(th.Space(0.5)).Radius(t.Radius.Lg).
		Background(t.GlassBg).Border(gwtheme.Hairline, t.GlassBorder)
	kit.Elevate(ctx, bar, gwtheme.ShadowMd)
	bar.Children(func() {
		s.toolButton(ctx, iconPlus, "添加", s.board.adding, func() {
			s.board.adding = !s.board.adding
		})
		s.toolButton(ctx, iconSearch, "搜索", s.board.search, func() {
			s.board.search = !s.board.search
		})
		s.toolButton(ctx, iconGrid, "网格", s.board.grid, func() {
			s.board.grid = !s.board.grid
		})
		s.toolButton(ctx, iconFocus, "聚焦", s.board.focus, func() {
			s.board.focus = !s.board.focus
		})
		s.toolButton(ctx, iconFit, "重置", false, func() {
			s.resetBoard()
		})
	})
	if s.board.adding {
		menu := ui.Column(ctx).Attach(ui.AnchorTopRight, ui.AnchorTopRight).Top(th.Space(12)).Right(th.Space(3)).
			Padding(th.Space(1)).Gap(th.Space(0.25)).Width(th.Space(48)).Radius(t.Radius.Lg).
			Background(t.Background).Border(gwtheme.Hairline, t.Border)
		kit.Elevate(ctx, menu, gwtheme.ShadowMd)
		menu.Children(func() {
			for _, kind := range boardModules {
				target := kind
				button := kit.Button(ctx, boardPanelTitle(target), kit.ButtonOpts{Variant: kit.Ghost})
				button.Justify(ui.Start).FillWidth()
				if button.Clicked() {
					s.openModule(target)
				}
			}
		})
	}
	if s.board.search {
		ui.Row(ctx).Attach(ui.AnchorTopLeft, ui.AnchorTopLeft).Top(th.Space(3)).Left(th.Space(3)).Width(th.Space(56)).Children(func() {
			kit.Input(ctx, &s.board.query, kit.InputOpts{Placeholder: "搜索白板内容", Glass: true})
		})
	}
}

func (s *shellState) toolButton(ctx *ui.Context, icon *ui.SVG, label string, on bool, action func()) {
	iconAction(ctx, icon, label, on, 8, action)
}

func iconAction(ctx *ui.Context, icon *ui.SVG, label string, selected bool, size float32, action func()) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	button := ui.Box(ctx).Size(th.Space(size), th.Space(size)).Radius(t.Radius.Md).Center().
		Label(label).Tooltip(label).Focusable()
	if action != nil {
		button.OnClick(action)
	}
	color := t.Muted
	switch {
	case selected:
		button.Background(t.SidebarSelected)
		color = t.Foreground
	case button.Hovered():
		button.Background(t.HoverTint)
		color = t.Foreground
	}
	button.Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(color)
	})
	return button
}

func (s *shellState) boardPanelView(ctx *ui.Context, panel *boardPanel, expanded bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := kit.Panel(ctx, t.Radius.Xl)
	if expanded {
		card.Fill()
	} else {
		card.Absolute().Left(panel.X).Top(panel.Y).Width(panel.W).Height(panel.H)
	}
	card.Children(func() {
		s.boardPanelHeader(ctx, panel, expanded)
		ui.Scroll(ctx).Grow(1).Padding(th.Space(3)).Children(func() {
			ui.Column(ctx).Gap(th.Space(2)).Children(func() {
				s.boardPanelBody(ctx, panel)
			})
		})
	})
}

func (s *shellState) boardPanelHeader(ctx *ui.Context, panel *boardPanel, expanded bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	header := ui.Row(ctx).FillWidth().Height(th.Space(9)).Padding(th.Space(2), th.Space(1)).
		Gap(th.Space(0.5)).AlignItems(ui.Center).Label(boardPanelTitle(panel.Kind) + "窗口").Focusable()
	if expanded {
		header.Padding(th.Space(2), th.Space(12), th.Space(1), th.Space(2))
	}
	if !expanded {
		if dx, dy, ok := header.Dragged(); ok {
			width, height := s.canvasSize()
			panel.X = clampFloat(panel.X+dx, 0, width-panel.W)
			panel.Y = clampFloat(panel.Y+dy, 0, height-panel.H)
			s.board.lastKind = panel.Kind
		}
		if _, _, ended := header.DragEnded(); ended {
			s.saveBoard()
		}
	}
	header.Children(func() {
		kit.Text(ctx, boardPanelTitle(panel.Kind), t.Text.Sm).TextColor(t.Muted).Grow(1).SingleLine()
		expandIcon := iconFit
		expandLabel := "展开"
		if expanded {
			expandIcon = iconClose
			expandLabel = "收起"
		}
		if iconAction(ctx, expandIcon, expandLabel, false, 6, func() {
			for index := range s.board.panels {
				s.board.panels[index].Expanded = s.board.panels[index].ID == panel.ID && !expanded
			}
			s.board.lastKind = panel.Kind
			s.saveBoard()
		}).Clicked() {
		}
		if iconAction(ctx, iconClose, "移除", false, 6, func() {
			s.closeModule(panel.ID)
		}).Clicked() {
		}
	})
}

func clampFloat(value, low, high float32) float32 {
	if high < low {
		return low
	}
	return min(max(value, low), high)
}
