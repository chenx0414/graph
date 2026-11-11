package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

type boardMode int

const (
	boardHome boardMode = iota
	boardChat
	boardHistory
	boardTasks
	boardGraph
	boardCapabilities
	boardSettings
)

type railItem struct {
	mode  boardMode
	label string
	icon  *ui.SVG
}

var railItems = []railItem{
	{boardHome, "概览", iconHome},
	{boardChat, "对话", iconChat},
	{boardHistory, "历史", iconClock},
	{boardTasks, "任务", iconDoc},
	{boardGraph, "图谱", iconGraph},
	{boardCapabilities, "能力", iconShare},
	{boardSettings, "设置", iconGear},
}

type boardState struct {
	mode        boardMode
	grid        bool
	search      bool
	outline     bool
	focus       bool
	query   string
	offsetX float32
	offsetY float32
}

func boardTitle(mode boardMode) string {
	switch mode {
	case boardChat:
		return "对话信息"
	case boardHistory:
		return "历史记录"
	case boardTasks:
		return "任务清单"
	case boardGraph:
		return "图谱画布"
	case boardCapabilities:
		return "能力库"
	case boardSettings:
		return "运行设置"
	}
	return "项目概览"
}

func (s *shellState) chooseBoard(mode boardMode) {
	s.board.mode = mode
	switch mode {
	case boardHome:
		s.ensureUsage()
	case boardCapabilities:
		s.ensureResources()
	case boardSettings:
		s.ensureSettings()
	case boardGraph:
		s.ensureGraph()
	}
}

func (s *shellState) ensureGraph() {
	active := s.active()
	if active == nil || len(active.tasks) == 0 || active.graphLoading {
		return
	}
	taskID := active.tasks[0].id
	if active.graphTaskID == taskID && len(active.graph.nodes) > 0 {
		return
	}
	active.graphLoading = true
	go active.loadGraph(taskID)
}

func (s *shellState) whiteboard(ctx *ui.Context) {
	t := ctx.Theme()
	board := ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Background(t.Surface).Radius(cardRadius).
		Border(1, t.Border).Shadow(0, 10, 28, 0, cardShadow).Clip()
	board.Draw(func(p *ui.Painter, r ui.Rect) {
		if !s.board.grid {
			return
		}
		p.Clip(r, cardRadius, func() {
			drawBoardGrid(p, r, s.board.offsetX, s.board.offsetY)
		})
	})
	board.Children(func() {
		ui.Row(ctx).Fill().AlignItems(ui.Stretch).Children(func() {
			if s.board.outline {
				s.boardOutline(ctx)
			}
			ui.Column(ctx).Grow(1).FillHeight().Padding(20).Gap(8).Children(func() {
				ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(ctx, boardTitle(s.board.mode)).FontSize(17).FontWeight(600)
					if s.board.search {
						ui.SearchField(ctx, &s.board.query).Placeholder("搜索白板内容").Label("白板搜索").Grow(1)
					}
				})
				ui.Scroll(ctx).Grow(1).Children(func() {
					ui.Column(ctx).Gap(8).Children(func() {
						s.boardBody(ctx)
					})
				})
			})
		})
		s.boardToolbar(ctx)
	})
}

func drawBoardGrid(p *ui.Painter, r ui.Rect, offsetX, offsetY float32) {
	const step, size = float32(26), float32(2)
	startX := r.X + 13 + offsetX
	startY := r.Y + 13 + offsetY
	for x := startX; x < r.X+r.W; x += step {
		for y := startY; y < r.Y+r.H; y += step {
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
		s.toolButton(ctx, iconSearch, "搜索", s.board.search, func() {
			s.board.search = !s.board.search
		})
		s.toolButton(ctx, iconList, "大纲", s.board.outline, func() {
			s.board.outline = !s.board.outline
		})
		s.toolButton(ctx, iconGrid, "网格", s.board.grid, func() {
			s.board.grid = !s.board.grid
		})
		s.toolButton(ctx, iconGraph, "图谱", s.board.mode == boardGraph, func() {
			s.chooseBoard(boardGraph)
		})
		s.toolButton(ctx, iconFocus, "聚焦", s.board.focus, func() {
			s.board.focus = !s.board.focus
		})
		s.toolButton(ctx, iconClose, "关闭", false, func() {
			s.chooseBoard(boardHome)
		})
	})
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

func (s *shellState) boardOutline(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Width(150).FillHeight().Padding(12).Gap(4).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		for _, item := range railItems {
			spec := item
			label := boardTitle(spec.mode)
			if s.board.mode == spec.mode {
				label = "• " + label
			}
			if ui.Button(ctx, label).Clicked() {
				s.chooseBoard(spec.mode)
			}
		}
	})
}

func (s *shellState) boardBody(ctx *ui.Context) {
	switch s.board.mode {
	case boardChat:
		s.boardConversation(ctx)
	case boardHistory:
		s.boardHistory(ctx)
	case boardTasks:
		s.boardTasks(ctx)
	case boardGraph:
		s.boardGraphPanel(ctx)
	case boardCapabilities:
		s.boardCapabilities(ctx)
	case boardSettings:
		s.boardSettings(ctx)
	default:
		s.boardOverview(ctx)
	}
}

func (s *shellState) boardMatches(text string) bool {
	query := strings.TrimSpace(s.board.query)
	if query == "" {
		return true
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(query))
}

func (s *shellState) boardNote(ctx *ui.Context, text string) {
	ui.Text(ctx, text).FontSize(13).TextColor(ctx.Theme().TextMuted)
}

func (s *shellState) boardOverview(ctx *ui.Context) {
	t := ctx.Theme()
	s.boardNote(ctx, "这台机器上的项目、会话与运行信息都呈现在这块白板上。")
	ui.Row(ctx).Wrap().Gap(10).Children(func() {
		s.statCard(ctx, "会话", strconv.Itoa(len(s.conversations)))
		s.statCard(ctx, "项目", strconv.Itoa(len(s.projectNames())))
		cost, tokens := "—", "—"
		if s.usage != nil {
			cost = formatCost(s.usage.rows.costMicros)
			tokens = formatTokens(s.usage.rows.tokens)
		}
		s.statCard(ctx, "用量", cost)
		s.statCard(ctx, "缓存命中", cacheLabel(s.usage))
		capabilityValue := "—"
		if s.usage != nil {
			ready := s.usage.rows.capabilities.ready
			missing := s.usage.rows.capabilities.missing
			capabilityValue = strconv.Itoa(ready) + "/" + strconv.Itoa(ready+missing)
		}
		s.statCard(ctx, "能力库", capabilityValue)
		s.statCard(ctx, "tokens", tokens)
	})
	if active := s.active(); active != nil {
		ui.Text(ctx, "当前会话 · "+s.titleOf(s.activeID)+" · "+active.status).FontSize(13).TextColor(t.TextMuted)
	}
	if s.usage != nil {
		ui.Text(ctx, "轮次 "+strconv.Itoa(s.usage.rows.turns)+" · 工具调用 "+strconv.Itoa(s.usage.rows.toolCalls)+" · 失败率 "+errorRate(s.usage.rows)).FontSize(12).TextColor(t.TextMuted)
	}
}

func cacheLabel(usage *usageState) string {
	if usage == nil {
		return "—"
	}
	return formatPercent(usage.rows.cacheHit)
}

func (s *shellState) statCard(ctx *ui.Context, label, value string) {
	t := ctx.Theme()
	ui.Column(ctx).Width(150).Height(76).Radius(14).Border(1, t.Border).Background(t.Surface).Padding(12).
		Justify(ui.SpaceBetween).Children(func() {
		ui.Text(ctx, value).FontSize(20).FontWeight(600).TextColor(t.Text)
		ui.Text(ctx, label).FontSize(12).TextColor(t.TextMuted)
	})
}

func (s *shellState) boardConversation(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	ui.Text(ctx, "会话 · "+s.titleOf(s.activeID)).FontSize(14).TextColor(t.Text)
	ui.Text(ctx, "状态 · "+active.status).FontSize(13).TextColor(t.TextMuted)
	if len(active.questions) > 0 {
		ui.Text(ctx, "待你决定 · "+strconv.Itoa(len(active.questions))+" 个问题").FontSize(13).TextColor(t.TextMuted)
	}
	if len(active.artifacts) > 0 {
		ui.Text(ctx, "产物 · "+strconv.Itoa(len(active.artifacts))+" 件").FontSize(13).TextColor(t.TextMuted)
	}
	if active.proposal.Version > 0 {
		ui.Text(ctx, "草案 v"+strconv.Itoa(active.proposal.Version)+" 待确认").FontSize(13).TextColor(t.TextMuted)
	}
	s.boardNote(ctx, "对话正文在中间的聊天窗口继续。")
}

func (s *shellState) boardHistory(ctx *ui.Context) {
	t := ctx.Theme()
	shown := 0
	for _, conversation := range s.conversations {
		if conversation.Role == "global" {
			continue
		}
		label := strings.TrimSpace(conversation.Title)
		if label == "" {
			label = "（无标题）"
		}
		project := strings.TrimSpace(conversation.ProjectID)
		if project == "" {
			project = "未分组"
		}
		if !s.boardMatches(label + " " + project) {
			continue
		}
		ui.Row(ctx).FillWidth().Gap(8).Children(func() {
			ui.Text(ctx, label).FontSize(13).TextColor(t.Text).Grow(1).SingleLine().Ellipsis("…")
			ui.Text(ctx, project).FontSize(11).TextColor(t.TextMuted)
		})
		shown++
	}
	if shown == 0 {
		s.boardNote(ctx, "没有匹配的历史记录。")
	}
}

func (s *shellState) boardTasks(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil || len(active.tasks) == 0 {
		s.boardNote(ctx, "当前会话还没有任务。任务启动后会在这里列出。")
		return
	}
	for _, task := range active.tasks {
		ui.Text(ctx, taskLabel(task)).FontSize(13).TextColor(t.Text)
		for _, node := range task.nodes {
			ui.Text(ctx, "  "+nodeLabel(node)).FontSize(12).TextColor(t.TextMuted)
		}
	}
}

func (s *shellState) boardGraphPanel(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil || len(active.tasks) == 0 {
		s.boardNote(ctx, "图谱会在任务启动后出现：节点是 Agent，连线是接口投递。")
		return
	}
	if active.graphError != "" {
		s.boardNote(ctx, active.graphError)
		return
	}
	if len(active.graph.nodes) == 0 {
		s.boardNote(ctx, "正在读取图谱…")
		return
	}
	caption := strconv.Itoa(len(active.graph.nodes)) + " 个节点 · " + strconv.Itoa(len(active.graph.edges)) + " 条连接"
	ui.Text(ctx, active.graphTaskID+" · "+caption).FontSize(12).TextColor(t.TextMuted)
	ui.Box(ctx).FillWidth().Height(520).Clip().Draw(func(p *ui.Painter, r ui.Rect) {
		drawBoardGraph(p, r, active.graph)
	})
}

func (s *shellState) boardCapabilities(ctx *ui.Context) {
	if s.resources == nil {
		s.boardNote(ctx, "正在读取能力库…")
		return
	}
	s.resources.view(ctx)
}

func (s *shellState) boardSettings(ctx *ui.Context) {
	if s.settings == nil {
		s.boardNote(ctx, "正在读取设置…")
		return
	}
	s.settings.view(ctx)
}
