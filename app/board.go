package main

import (
	"strconv"
	"time"

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
	{"trajectory", "轨迹", iconActivity},
	{"insights", "洞察", iconTrend},
	{"tasks", "任务", iconDoc},
	{"graph", "图谱", iconGraph},
	{"capabilities", "能力", iconShare},
	{"settings", "设置", iconGear},
}

type boardState struct {
	pages      []boardPage
	active     int
	path       string
	drag       *boardDrag
	rects      map[string]ui.Rect
	splits     map[string]ui.Rect
	press      string
	pressX     float32
	pressY     float32
	hoverSince map[string]time.Time
}

type boardDrag struct {
	panelID string
	target  string
	edge    string
	dx      float32
	dy      float32
}

func (s *shellState) boardTabBar(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	column := ui.Column(ctx).Grow(1).FillWidth().Height(bandHeight).Label("白板标题")
	column.Children(func() {
		strip := ui.Row(ctx).FillWidth().Height(bandHeight-gwtheme.Stroke).Padding(0, th.Space(2.5)).
			Gap(0).AlignItems(ui.Center)
		strip.Children(func() {
			previousActive, previousHovered := false, false
			for index := range s.board.pages {
				pageIndex := index
				page := s.board.pages[index]
				active := pageIndex == s.board.active
				tab := ui.Row(ctx).Height(th.Space(7.5)).PaddingX(th.Space(2.5)).Gap(th.Space(1)).
					Radius(t.Radius.Xl).AlignItems(ui.Center).Focusable().Label("标签页 " + page.Title)
				if index == 0 {
					tab.ContextMenu(func(m *ui.Menu) {
						if m.Item("重置白板为默认初始状态").Chosen() {
							s.resetBoardPage()
						}
					})
				}
				hovered := tab.Hovered()
				if !previousActive && !previousHovered && !active && !hovered && index > 0 {
					ui.Box(ctx).Width(gwtheme.Stroke).Height(th.Space(3.5)).Background(columnLine(t))
				}
				switch {
				case active:
					tab.Background(t.Background).Border(gwtheme.Stroke, t.Border)
				case hovered:
					tab.Background(t.HoverTint)
				}
				tab.OnClick(func() { s.selectBoardPage(pageIndex) })
				tab.Children(func() {
					color := t.Muted
					if active {
						color = t.Foreground
					}
					kit.Text(ctx, page.Title, t.Text.Lg).TextColor(color).SingleLine()
					if index > 0 && len(s.board.pages) > 1 && (active || hovered) {
						iconAction(ctx, iconClose, "关闭 "+page.Title, false, 4.5, func() { s.closeBoardPage(pageIndex) })
					}
				})
				previousActive, previousHovered = active, hovered
			}
		})
	})
}

func (s *shellState) boardPageView(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	page := s.boardPage()
	if s.board.rects == nil {
		s.board.rects = map[string]ui.Rect{}
	}
	if s.board.splits == nil {
		s.board.splits = map[string]ui.Rect{}
	}
	card := ui.Column(ctx).Grow(1).FillWidth().Background(t.Sidebar)
	card.Children(func() {
		if page.Kind != "" && len(page.Panels) == 1 {
			s.boardPanelView(ctx, &page.Panels[0], false, false)
			return
		}
		if page.Kind != "" {
			if s.boardScrollTop {
				s.boardScroll.Y = 0
				s.boardScrollTop = false
			}
			ui.Scroll(ctx).Fill().TrackScroll(&s.boardScroll).Children(func() {
				grid := ui.Column(ctx).FillWidth().Padding(10).Gap(10)
				grid.Children(func() {
					for row := 0; row*2 < len(page.Panels); row++ {
						rowIndex := row
						ui.Row(ctx).FillWidth().Height(boardCardHeight).Gap(10).Children(func() {
							for column := 0; column < 2; column++ {
								index := rowIndex*2 + column
								if index >= len(page.Panels) {
									break
								}
								panel := page.Panels[index]
								cell := ui.Column(ctx).Grow(1).FillHeight()
								cell.Children(func() {
									s.boardPanelView(ctx, &panel, false, false)
								})
							}
						})
					}
				})
			})
			return
		}
		if len(page.Panels) == 0 {
			kit.Text(ctx, "这个标签页还没有模块，点左侧栏的图标打开一个模块。", t.Text.Sm).
				TextColor(t.Muted).Padding(24, 24, 24, 24)
			return
		}
		freeform := page.Kind == ""
		ui.Column(ctx).Fill().Padding(10).Children(func() {
			s.boardNodeView(ctx, &page.Layout, "root", freeform, page.Kind == "")
		})
	})
}

func (s *shellState) boardNodeView(ctx *ui.Context, node *boardNode, path string, freeform, autoHide bool) {
	switch node.Kind {
	case "panel":
		panel := s.panelByID(node.PanelID)
		if panel == nil {
			return
		}
		s.boardPanelView(ctx, panel, freeform, autoHide)
	case "split":
		var container ui.Element
		if node.Axis == "row" {
			container = ui.Row(ctx).Fill()
		} else {
			container = ui.Column(ctx).Fill()
		}
		container.Draw(func(p *ui.Painter, r ui.Rect) { s.board.splits[path] = r })
		container.Children(func() {
			for index := range node.Children {
				if index > 0 {
					s.boardDivider(ctx, node, path, index-1)
				}
				slot := node.Children[index]
				childPath := path + "/" + strconv.Itoa(index)
				var cell ui.Element
				if node.Axis == "row" {
					cell = ui.Column(ctx).Grow(slot.Weight).FillHeight()
				} else {
					cell = ui.Row(ctx).Grow(slot.Weight).FillWidth()
				}
				cell.Children(func() {
					s.boardNodeView(ctx, &slot.Node, childPath, freeform, autoHide)
				})
			}
		})
	}
}

func (s *shellState) boardDivider(ctx *ui.Context, node *boardNode, path string, gap int) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	var handle ui.Element
	if node.Axis == "row" {
		handle = ui.Box(ctx).Width(th.Space(2)).FillHeight()
	} else {
		handle = ui.Box(ctx).Height(th.Space(2)).FillWidth()
	}
	handle.Label("调整分区").Focusable()
	if node.Axis == "row" {
		handle.Cursor(ui.CursorResizeEW)
	} else {
		handle.Cursor(ui.CursorResizeNS)
	}
	if handle.Hovered() {
		handle.Background(t.HoverTint)
	}
	if dx, dy, ok := handle.Dragged(); ok {
		s.resizeBoardSplit(node, path, gap, dx, dy)
	}
	if _, _, ended := handle.DragEnded(); ended {
		s.saveBoard()
	}
}

func (s *shellState) resizeBoardSplit(node *boardNode, path string, gap int, dx, dy float32) {
	if gap < 0 || gap+1 >= len(node.Children) {
		return
	}
	rect, ok := s.board.splits[path]
	if !ok {
		return
	}
	available, delta, minWeight := rect.W, dx, float32(0)
	if node.Axis == "column" {
		available, delta = rect.H, dy
	}
	if available <= 0 {
		return
	}
	total := float32(0)
	for _, slot := range node.Children {
		total += slot.Weight
	}
	if node.Axis == "row" {
		minWeight = boardMinPaneWidth / available * total
	} else {
		minWeight = boardMinPaneHeight / available * total
	}
	left, right := node.Children[gap].Weight, node.Children[gap+1].Weight
	proposed := left + delta/available*total
	proposed = min(max(proposed, minWeight), left+right-minWeight)
	if proposed <= 0 || left+right-proposed <= 0 {
		return
	}
	node.Children[gap].Weight = proposed
	node.Children[gap+1].Weight = left + right - proposed
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

func (s *shellState) boardPanelView(ctx *ui.Context, panel *boardPanel, freeform, autoHide bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := kit.Panel(ctx, t.Radius.Xl)
	card.Fill().Label(boardPanelTitle(panel.Kind) + "窗口")
	if autoHide {
		kit.Elevate(ctx, card, shellShadow)
	}
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		if freeform {
			s.board.rects[panel.ID] = r
		}
	})
	card.OnClick(func() {})
	headerProgress := float32(1)
	if autoHide {
		target := float32(0)
		if _, _, over := card.PointerPosition(); over {
			target = 1
		}
		headerProgress = card.Animate("card-header", target, 160*time.Millisecond)
	}
	if freeform {
		card.Drag(panel.ID).Cursor(ui.CursorGrab)
		if s.board.drag != nil && s.board.drag.panelID == panel.ID {
			card.Cursor(ui.CursorGrabbing)
		}
	}
	card.Children(func() {
		if !autoHide {
			s.boardPanelHeader(ctx, panel, freeform)
		}
		body := ui.Scroll(ctx).Grow(1).Padding(th.Space(3))
		body.MaskLinearGradient(ui.LinearGradient{Angle: 180, Stops: []ui.GradientStop{
			{Color: ui.Transparent, At: 0},
			{Color: ui.RGB(0, 0, 0), At: 0.08},
			{Color: ui.RGB(0, 0, 0), At: 0.92},
			{Color: ui.Transparent, At: 1},
		}})
		body.Children(func() {
			content := ui.Column(ctx).FillWidth().Gap(th.Space(2))
			content.MaskLinearGradient(ui.LinearGradient{Angle: 90, Stops: []ui.GradientStop{
				{Color: ui.RGB(0, 0, 0), At: 0},
				{Color: ui.RGB(0, 0, 0), At: 0.88},
				{Color: ui.Transparent, At: 1},
			}})
			content.Children(func() {
				s.boardPanelBody(ctx, panel)
			})
		})
		if autoHide {
			header := s.boardPanelHeader(ctx, panel, freeform)
			header.Absolute().Top(0).Left(0).Right(0).Background(t.Background).
				Translate(0, -(1-headerProgress)*th.Space(9)).Opacity(headerProgress).
				IgnoreInput(headerProgress < 0.5)
		}
		if freeform {
			rect, hasRect := s.board.rects[panel.ID]
			if card.Pressed() && hasRect && s.board.press != panel.ID {
				if px, py, over := card.PointerPosition(); over {
					s.board.press = panel.ID
					s.board.pressX = rect.X + px
					s.board.pressY = rect.Y + py
				}
			}
			if dx, dy, ok := card.Dragged(); ok {
				s.dragBoardPanel(panel, dx, dy)
			}
			if point, missed := card.DragMissed(); missed {
				s.dropBoardPanelAt(panel.ID, point.X, point.Y)
			}
			if _, _, ended := card.DragEnded(); ended {
				s.dropBoardPanel()
			}
			s.boardDropPreview(ctx, panel)
		}
	})
}

func (s *shellState) boardPanelHeader(ctx *ui.Context, panel *boardPanel, freeform bool) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	header := ui.Row(ctx).FillWidth().Height(th.Space(9)).Padding(th.Space(2), th.Space(1)).
		Gap(th.Space(0.5)).AlignItems(ui.Center).Label(boardPanelTitle(panel.Kind) + "窗口")
	header.Children(func() {
		kit.Text(ctx, boardPanelTitle(panel.Kind), t.Text.Sm).TextColor(t.Muted).Grow(1).SingleLine().IgnoreInput(true)
		if !freeform {
			return
		}
		iconAction(ctx, iconFit, "在新标签页打开", false, 6, func() {
			s.openModule(panel.Kind)
		})
		iconAction(ctx, iconClose, "移除", false, 6, func() {
			s.closeModule(panel.ID)
		})
	})
	return header
}

func (s *shellState) boardDropPreview(ctx *ui.Context, panel *boardPanel) {
	drag := s.board.drag
	if drag == nil || drag.target != panel.ID {
		return
	}
	t := gwtheme.Of(ctx)
	tint := t.Unread.Alpha(0.18)
	switch drag.edge {
	case "left", "right":
		row := ui.Row(ctx).Fill().IgnoreInput(true)
		row.Children(func() {
			if drag.edge == "left" {
				ui.Box(ctx).Grow(1).FillHeight().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
				ui.Box(ctx).Grow(1).FillHeight()
				return
			}
			ui.Box(ctx).Grow(1).FillHeight()
			ui.Box(ctx).Grow(1).FillHeight().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
		})
	case "top", "bottom":
		column := ui.Column(ctx).Fill().IgnoreInput(true)
		column.Children(func() {
			if drag.edge == "top" {
				ui.Box(ctx).Grow(1).FillWidth().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
				ui.Box(ctx).Grow(1).FillWidth()
				return
			}
			ui.Box(ctx).Grow(1).FillWidth()
			ui.Box(ctx).Grow(1).FillWidth().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
		})
	default:
		ui.Box(ctx).Fill().IgnoreInput(true).Background(tint).Border(2, t.Unread).Radius(t.Radius.Xl)
	}
}

func (s *shellState) dragBoardPanel(panel *boardPanel, dx, dy float32) {
	if s.board.drag == nil || s.board.drag.panelID != panel.ID {
		s.board.drag = &boardDrag{panelID: panel.ID}
	}
	s.board.drag.dx += dx
	s.board.drag.dy += dy
	s.updateBoardDragTarget()
}

func (s *shellState) updateBoardDragTarget() {
	drag := s.board.drag
	if drag == nil {
		return
	}
	rect, ok := s.board.rects[drag.panelID]
	if !ok {
		return
	}
	pointX := rect.X + rect.W/2 + drag.dx
	pointY := rect.Y + rect.H/2 + drag.dy
	if s.board.press == drag.panelID {
		pointX = s.board.pressX + drag.dx
		pointY = s.board.pressY + drag.dy
	}
	drag.target, drag.edge = s.boardDropTarget(drag.panelID, pointX, pointY)
}

func (s *shellState) boardDropTarget(sourceID string, pointX, pointY float32) (string, string) {
	for id, target := range s.board.rects {
		if id == sourceID || target.W <= 0 || target.H <= 0 {
			continue
		}
		if pointX < target.X || pointX > target.X+target.W || pointY < target.Y || pointY > target.Y+target.H {
			continue
		}
		return id, boardDropEdge((pointX-target.X)/target.W, (pointY-target.Y)/target.H)
	}
	return "", ""
}

func (s *shellState) dropBoardPanelAt(sourceID string, pointX, pointY float32) {
	drag := s.board.drag
	if drag == nil || drag.panelID != sourceID {
		drag = &boardDrag{panelID: sourceID}
	}
	drag.target, drag.edge = s.boardDropTarget(sourceID, pointX, pointY)
	s.board.drag = drag
	s.dropBoardPanel()
}

func boardDropEdge(x, y float32) string {
	if x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75 {
		return "center"
	}
	edge := "left"
	distance := x
	if 1-x < distance {
		edge, distance = "right", 1-x
	}
	if y < distance {
		edge, distance = "top", y
	}
	if 1-y < distance {
		edge = "bottom"
	}
	return edge
}

func (s *shellState) dropBoardPanel() {
	drag := s.board.drag
	s.board.drag = nil
	s.board.press = ""
	if drag == nil || drag.target == "" {
		return
	}
	page := s.boardPage()
	if drag.edge == "center" {
		swapBoardPanels(&page.Layout, drag.panelID, drag.target)
	} else {
		splitBoardPane(&page.Layout, drag.target, drag.panelID, drag.edge)
	}
	normalizeBoardLayout(&page.Layout)
	pruneBoardPanels(page)
	s.saveBoard()
	s.frame()
}
