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
	{"fleet", "编队", iconNetwork},
	{"providers", "供应商", iconDatabase},
	{"capabilities", "资源", iconShare},
	{"assemblies", "装配", iconLayers},
	{"settings", "设置", iconGear},
}

const (
	boardHeaderMotion = 160 * time.Millisecond
	boardPanelPadding = float32(12)
)

type boardHeaderMode int

const (
	boardHeaderAlways boardHeaderMode = iota
	boardHeaderOnHover
	boardHeaderNone
)

type boardState struct {
	pages       []boardPage
	active      int
	path        string
	drag        *boardDrag
	rects       map[string]ui.Rect
	splits      map[string]ui.Rect
	scrolls     map[string]*ui.ScrollState
	press       string
	pressX      float32
	pressY      float32
	hoverSince  map[string]time.Time
	pendingDrop func()
	viewport    ui.Rect
}

type boardDrag struct {
	panelID string
	target  string
	edge    string
	dx      float32
	dy      float32
}

func (s *shellState) boardScrollOf(panelID string) *ui.ScrollState {
	if s.board.scrolls == nil {
		s.board.scrolls = map[string]*ui.ScrollState{}
	}
	scroll := s.board.scrolls[panelID]
	if scroll == nil {
		scroll = &ui.ScrollState{}
		s.board.scrolls[panelID] = scroll
	}
	return scroll
}

func (s *shellState) boardTabBar(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	column := ui.Column(ctx).Grow(1).FillWidth().Height(titleBandHeight(ctx)).Label("白板标题")
	column.Children(func() {
		strip := ui.Row(ctx).FillWidth().Height(titleBandHeight(ctx)).Padding(0, th.Space(2.5)).
			Gap(0).AlignItems(ui.Center)
		strip.Children(func() {
			previousActive, previousHovered := false, false
			for index := range s.board.pages {
				pageIndex := index
				page := s.board.pages[index]
				active := pageIndex == s.board.active
				tab := ui.Row(ctx).Height(th.Space(7.5)).PaddingX(th.Space(2.5)).Gap(th.Space(1)).
					Radius(t.Radius.Xl).AlignItems(ui.Center).MaxWidth(th.Space(40)).Focusable().Label("标签页 " + page.Title)
				switch {
				case index == 0:
					tab.ContextMenu(func(m *ui.Menu) {
						if m.Item("重置白板为默认初始状态").Chosen() {
							s.resetBoardPage()
						}
					})
				case page.ID == fleetPageID || page.Kind == fleetPageID:
					tab.ContextMenu(func(m *ui.Menu) {
						if m.Item("重置编队为默认初始状态").Chosen() {
							s.resetFleetPage()
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
					kit.Text(ctx, page.Title, t.Text.Lg).TextColor(color).SingleLine().Ellipsis("…").Translate(0, -0.6)
					if index > 0 && len(s.board.pages) > 1 && (active || hovered) && boardPageClosable(page) {
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
	if drop := s.board.pendingDrop; drop != nil {
		s.board.pendingDrop = nil
		drop()
	}
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
			header := boardHeaderOnHover
			if page.Title == boardPanelTitle(page.Panels[0].Kind) {
				header = boardHeaderNone
			}
			s.boardCanvas(ctx, func() {
				s.boardPanelView(ctx, &page.Panels[0], false, header)
			})
			return
		}
		if page.Kind == fleetPageID {
			s.boardCanvas(ctx, func() {
				s.boardNodeView(ctx, &page.Layout, "root", true, boardHeaderOnHover)
			})
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
					rows := boardModuleRows(page.Panels)
					for _, row := range rows {
						panels := row
						ui.Row(ctx).FillWidth().Height(boardCardHeight).Gap(10).Children(func() {
							for index := range panels {
								panel := panels[index]
								cell := ui.Column(ctx).Grow(1).FillHeight().
									MinWidth(s.boardPanelMinWidthWithChrome(ctx, &panel))
								cell.Children(func() {
									s.boardPanelView(ctx, &panel, false, boardHeaderOnHover)
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
		s.boardCanvas(ctx, func() {
			s.boardNodeView(ctx, &page.Layout, "root", freeform, boardHeaderOnHover)
		})
	})
}

func boardModuleRows(panels []boardPanel) [][]boardPanel {
	rows := [][]boardPanel{}
	pending := []boardPanel{}
	flush := func() {
		if len(pending) == 0 {
			return
		}
		rows = append(rows, pending)
		pending = nil
	}
	for _, panel := range panels {
		if boardPanelFullWidth(panel.Kind) {
			flush()
			rows = append(rows, []boardPanel{panel})
			continue
		}
		pending = append(pending, panel)
		if len(pending) == 2 {
			flush()
		}
	}
	flush()
	return rows
}

func boardPanelFullWidth(kind string) bool {
	return kind == "context-overview"
}

func (s *shellState) boardNodeView(ctx *ui.Context, node *boardNode, path string, freeform bool, header boardHeaderMode) {
	switch node.Kind {
	case "panel":
		panel := s.panelByID(node.PanelID)
		if panel == nil {
			return
		}
		s.boardPanelView(ctx, panel, freeform, header)
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
					cell = ui.Column(ctx).Grow(slot.Weight).FillHeight().
						MinWidth(s.boardNodeMinWidth(ctx, &slot.Node) + boardCardChrome(ctx))
				} else {
					cell = ui.Row(ctx).Grow(slot.Weight).FillWidth().
						MinHeight(s.boardNodeMinHeight(ctx, &slot.Node))
				}
				cell.Children(func() {
					s.boardNodeView(ctx, &slot.Node, childPath, freeform, header)
				})
			}
		})
	}
}

func (s *shellState) boardCanvas(ctx *ui.Context, build func()) {
	th := ctx.Theme()
	padding := th.Space(2.5)
	want := s.boardNodeMinHeight(ctx, &s.boardPage().Layout) + padding*2
	height := max(s.board.viewport.H, want)
	scroll := ui.Scroll(ctx).Fill()
	scroll.Draw(func(p *ui.Painter, r ui.Rect) { s.board.viewport = r })
	scroll.Children(func() {
		canvas := ui.Column(ctx).FillWidth().Height(height).Padding(padding)
		canvas.Children(build)
	})
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

func (s *shellState) boardPanelView(ctx *ui.Context, panel *boardPanel, freeform bool, header boardHeaderMode) {
	t := gwtheme.Of(ctx)
	card := kit.Panel(ctx, t.Radius.Xl)
	card.Fill()
	if header != boardHeaderNone {
		card.Label(boardPanelTitle(panel.Kind) + "窗口")
	}
	kit.Elevate(ctx, card, shellShadow)
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		if s.board.rects != nil {
			s.board.rects[panel.ID] = r
		}
	})
	card.OnClick(func() {})
	card.ContextMenu(func(m *ui.Menu) {
		if m.Item("在新标签页打开").Chosen() {
			s.openModuleWithScope(panel.Kind, panel.Scope)
		}
		if m.Item("移除").Chosen() {
			s.closeModule(panel.ID)
		}
	})
	headerProgress := float32(1)
	if header == boardHeaderOnHover {
		target := float32(0)
		if _, _, over := card.PointerPosition(); over {
			target = 1
		}
		headerProgress = card.Animate("card-header", target, boardHeaderMotion)
	}
	if freeform {
		card.Drag(panel.ID).Cursor(ui.CursorGrab)
		if s.board.drag != nil && s.board.drag.panelID == panel.ID {
			card.Cursor(ui.CursorGrabbing)
		}
	}
	card.Children(func() {
		if header == boardHeaderAlways {
			s.boardPanelHeader(ctx, panel, freeform)
		}
		s.boardPanelContent(ctx, panel)
		if header == boardHeaderOnHover {
			s.boardFloatingHeader(ctx, panel, freeform, headerProgress)
		}
		if freeform {
			s.boardPanelDrag(ctx, card, panel)
		}
	})
}

func (s *shellState) boardPanelContent(ctx *ui.Context, panel *boardPanel) {
	th := ctx.Theme()
	if boardPanelFills(panel.Kind) {
		ui.Box(ctx).Grow(1).Padding(boardPanelPadding).Children(func() {
			content := ui.Column(ctx).FillWidth().Gap(th.Space(2)).FillHeight()
			content.Children(func() {
				s.boardPanelBody(ctx, panel)
			})
		})
		return
	}
	scroll := s.boardScrollOf(panel.ID)
	top, bottom := fadeInsets(scroll)
	body := ui.Scroll(ctx).Grow(1).Padding(boardPanelPadding).TrackScroll(scroll)
	body.MaskLinearGradient(ui.LinearGradient{Angle: 180, Stops: []ui.GradientStop{
		{Color: ui.Transparent, At: 0},
		{Color: ui.RGB(0, 0, 0), At: 0.08},
		{Color: ui.RGB(0, 0, 0), At: 0.92},
		{Color: ui.Transparent, At: 1},
	}})
	body.Children(func() {
		content := ui.Column(ctx).FillWidth().Gap(th.Space(2))
		if top > 0 || bottom > 0 {
			content.Padding(top, 0, bottom, 0)
		}
		content.Children(func() {
			s.boardPanelBody(ctx, panel)
		})
	})
}

func (s *shellState) boardFloatingHeader(ctx *ui.Context, panel *boardPanel, freeform bool, progress float32) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	header := s.boardPanelHeader(ctx, panel, freeform).Label(boardPanelTitle(panel.Kind) + "标题")
	header.Absolute().Top(0).Left(0).Right(0).Background(t.Background).
		Translate(0, -(1-progress)*th.Space(9)).Opacity(progress).
		Hidden(progress <= 0.001).
		IgnoreInput(progress < 0.5)
}

func (s *shellState) boardPanelDrag(ctx *ui.Context, card ui.Element, panel *boardPanel) {
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
		s.deferBoardDrop(func() { s.dropBoardPanelAt(panel.ID, point.X, point.Y) })
	}
	if _, _, ended := card.DragEnded(); ended {
		s.deferBoardDrop(func() { s.dropBoardPanel() })
	}
	s.boardDropPreview(ctx, panel)
}

func boardPanelFills(kind string) bool {
	switch kind {
	case "agent-network", "graph-dag":
		return true
	}
	return false
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
			s.openModuleWithScope(panel.Kind, panel.Scope)
		})
		iconAction(ctx, iconClose, "移除", false, 6, func() {
			s.closeModule(panel.ID)
		})
	})
	return header
}
