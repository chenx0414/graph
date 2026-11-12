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

type boardState struct {
	pages  []boardPage
	active int
	path   string
}

func (s *shellState) whiteboard(ctx *ui.Context) {
	ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Children(func() {
		s.boardTabBar(ctx)
		s.boardPageView(ctx)
	})
}

func (s *shellState) boardTabBar(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Row(ctx).FillWidth().Height(th.Space(9)).Padding(th.Space(0.5), th.Space(1)).
		Gap(th.Space(1)).AlignItems(ui.Center)
	bar.Children(func() {
		for index := range s.board.pages {
			pageIndex := index
			page := s.board.pages[index]
			active := pageIndex == s.board.active
			tab := ui.Row(ctx).Height(th.Space(8)).PaddingX(th.Space(2.5)).Gap(th.Space(1.5)).
				Radius(t.Radius.Md).AlignItems(ui.Center).Focusable().Label("标签页 " + page.Title)
			switch {
			case active:
				tab.Background(t.Background).Border(gwtheme.Hairline, t.Border)
			case tab.Hovered():
				tab.Background(t.HoverTint)
			}
			tab.OnClick(func() { s.selectBoardPage(pageIndex) })
			tab.Children(func() {
				kit.Text(ctx, page.Title, t.Text.Sm).TextColor(t.Muted).SingleLine()
				if len(s.board.pages) > 1 && (active || tab.Hovered()) {
					iconAction(ctx, iconClose, "关闭 "+page.Title, false, 5, func() { s.closeBoardPage(pageIndex) })
				}
			})
		}
		iconAction(ctx, iconPlus, "新建标签页", false, 7, func() { s.addBoardPage() })
	})
}

func (s *shellState) boardPageView(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	page := s.boardPage()
	card := ui.Column(ctx).Grow(1).FillWidth().Background(t.Window).
		Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Clip()
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		p.Clip(r, t.Radius.Xl, func() {
			drawBoardGrid(p, r, t.Grid)
		})
	})
	card.Children(func() {
		if page.Kind != "" && len(page.Panels) > 0 {
			s.boardPanelView(ctx, &page.Panels[0], true)
			return
		}
		if len(page.Panels) == 0 {
			kit.Text(ctx, "这个标签页还没有模块，点左侧栏的图标打开一个模块。", t.Text.Sm).
				TextColor(t.Muted).Padding(24, 24, 24, 24)
			return
		}
		width, height := s.canvasSize()
		ui.ScrollBoth(ctx).Fill().Children(func() {
			ui.Box(ctx).Width(width).Height(height).Children(func() {
				for index := range page.Panels {
					s.boardPanelView(ctx, &page.Panels[index], false)
				}
			})
		})
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
		}
		if _, _, ended := header.DragEnded(); ended {
			s.saveBoard()
		}
	}
	header.Children(func() {
		kit.Text(ctx, boardPanelTitle(panel.Kind), t.Text.Sm).TextColor(t.Muted).Grow(1).SingleLine()
		if expanded {
			return
		}
		iconAction(ctx, iconFit, "在新标签页打开", false, 6, func() {
			s.openModule(panel.Kind)
		})
		iconAction(ctx, iconClose, "移除", false, 6, func() {
			s.closeModule(panel.ID)
		})
	})
}

func clampFloat(value, low, high float32) float32 {
	if high < low {
		return low
	}
	return min(max(value, low), high)
}
