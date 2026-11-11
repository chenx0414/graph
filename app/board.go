package main

import "github.com/egoist/mygo/ui"

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
	t := ctx.Theme()
	card := ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Background(t.Surface).
		Radius(cardRadius).Border(1, t.Border).Shadow(0, 10, 28, 0, cardShadow).Clip()
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		if !s.board.grid {
			return
		}
		p.Clip(r, cardRadius, func() {
			drawBoardGrid(p, r)
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

func drawBoardGrid(p *ui.Painter, r ui.Rect) {
	const step, size = float32(26), float32(2)
	for x := r.X + 13; x < r.X+r.W; x += step {
		for y := r.Y + 13; y < r.Y+r.H; y += step {
			p.Fill(ui.Rect{X: x - size/2, Y: y - size/2, W: size, H: size}, boardDot, 0)
		}
	}
}

func (s *shellState) boardToolbar(ctx *ui.Context) {
	t := ctx.Theme()
	bar := ui.Row(ctx).Attach(ui.AnchorTopRight, ui.AnchorTopRight).Top(12).Right(12).Padding(4).Gap(2).
		Radius(14).Background(ui.RGBA(255, 255, 255, 0.92)).Border(1, t.Border).
		Shadow(0, 8, 24, 0, cardShadow)
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
		menu := ui.Column(ctx).Attach(ui.AnchorTopRight, ui.AnchorTopRight).Top(54).Right(12).Padding(6).Gap(2).
			Radius(12).Background(t.Surface).Border(1, t.Border).Shadow(0, 10, 28, 0, cardShadow)
		menu.Children(func() {
			for _, kind := range boardModules {
				target := kind
				if ui.Button(ctx, boardPanelTitle(target)).Clicked() {
					s.openModule(target)
				}
			}
		})
	}
	if s.board.search {
		ui.Row(ctx).Attach(ui.AnchorTopLeft, ui.AnchorTopLeft).Top(12).Left(12).Width(220).Children(func() {
			field := ui.SearchField(ctx, &s.board.query).Placeholder("搜索白板内容").Label("白板搜索")
			field.Background(ui.RGBA(255, 255, 255, 0.92)).Border(1, t.Border).Radius(12).Padding(6, 10)
		})
	}
}

func (s *shellState) toolButton(ctx *ui.Context, icon *ui.SVG, label string, on bool, action func()) {
	t := ctx.Theme()
	button := ui.Box(ctx).Size(30, 30).Radius(9).Center().Label(label).Tooltip(label).Focusable()
	button.OnClick(action)
	if on {
		button.Background(t.Accent.Alpha(0.14))
	} else {
		button.Background(ui.Transparent)
	}
	button.Children(func() {
		color := t.TextMuted
		if on {
			color = t.Accent
		}
		ui.Icon(ctx, icon).FontSize(16).TextColor(color)
	})
}

func (s *shellState) boardPanelView(ctx *ui.Context, panel *boardPanel, expanded bool) {
	t := ctx.Theme()
	card := ui.Column(ctx).Background(t.Surface).Radius(14).Border(1, t.Border).
		Shadow(0, 8, 22, 0, cardShadow).Clip()
	if expanded {
		card.Fill()
	} else {
		card.Absolute().Left(panel.X).Top(panel.Y).Width(panel.W).Height(panel.H)
	}
	card.Children(func() {
		s.boardPanelHeader(ctx, panel, expanded)
		ui.Scroll(ctx).Grow(1).Padding(12).Children(func() {
			ui.Column(ctx).Gap(8).Children(func() {
				s.boardPanelBody(ctx, panel)
			})
		})
	})
}

func (s *shellState) boardPanelHeader(ctx *ui.Context, panel *boardPanel, expanded bool) {
	t := ctx.Theme()
	header := ui.Row(ctx).FillWidth().Height(32).Padding(10, 4).Gap(2).AlignItems(ui.Center).
		Label(boardPanelTitle(panel.Kind) + "窗口").Focusable()
	if expanded {
		header.Padding(10, 200, 4, 10)
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
		ui.Text(ctx, boardPanelTitle(panel.Kind)).FontSize(12).TextColor(t.TextMuted).Grow(1).SingleLine()
		expandLabel := "展开"
		if expanded {
			expandLabel = "收起"
		}
		if ui.Button(ctx, expandLabel).Clicked() {
			for index := range s.board.panels {
				s.board.panels[index].Expanded = s.board.panels[index].ID == panel.ID && !expanded
			}
			s.board.lastKind = panel.Kind
			s.saveBoard()
		}
		if ui.Button(ctx, "移除").Clicked() {
			s.closeModule(panel.ID)
		}
	})
}

func clampFloat(value, low, high float32) float32 {
	if high < low {
		return low
	}
	return min(max(value, low), high)
}
