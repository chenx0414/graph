package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) panelFleetGraph(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	state := s.graph
	if state.taskID == "" || state.taskID != fleetGraphTaskIDOfPage(s.boardPage().ID) {
		s.ensureFleetGraph()
		s.fleetGraphMessage(ctx, "正在读取 Graph 拓扑…", t.Muted)
		return
	}
	if state.loading && state.data == nil {
		s.fleetGraphMessage(ctx, "正在读取 Graph 拓扑…", t.Muted)
		return
	}
	if state.failed != "" {
		s.fleetGraphMessage(ctx, state.failed, t.Danger)
		ui.Row(ctx).FillWidth().Justify(ui.Center).Children(func() {
			kit.Button(ctx, "重试", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).OnClick(func() {
				s.graph.failed = ""
				s.graph.taskID = ""
				s.ensureFleetGraph()
				s.frame()
			})
		})
		return
	}
	data := state.data
	if data == nil || len(data.Nodes) == 0 {
		s.fleetGraphMessage(ctx, "这张图还没有节点。", t.Muted)
		return
	}
	unit, _ := s.fleetGraphUnit(data.TaskID)
	threadName, threadAgent := s.fleetGraphThread(unit)
	s.panelFleetGraphHeader(ctx, data, unit, threadName, threadAgent)
	s.fleetGraphCanvas(ctx, data)
}

func (s *shellState) fleetGraphMessage(ctx *ui.Context, text string, color ui.Color) {
	t := gwtheme.Of(ctx)
	ui.Column(ctx).FillWidth().Grow(1).Justify(ui.Center).Children(func() {
		kit.Text(ctx, text, t.Text.Sm).TextColor(color)
	})
}

func (s *shellState) fleetGraphCanvas(ctx *ui.Context, data *fleetTopologyData) {
	if s.fleet.accents == nil && s.fleet.data != nil {
		s.fleetNetworkModels(s.fleet.data)
	}
	s.fleetHoverScope(s.boardPage().ID)
	view := &s.graph.view
	if view.fit && view.worldW > 0 && view.worldW != data.Width {
		view.fit = false
	}
	edges := make([]canvasEdge, 0, len(data.Edges))
	for _, edge := range data.Edges {
		if len(edge.Points) < 2 {
			continue
		}
		color := gwtheme.Of(ctx).Border
		if agent := s.fleetTopologyAgent(data.TaskID, edge.To); agent != nil {
			if value, ok := s.fleet.accents[agent.ID]; ok {
				color = value
			}
		} else if node, ok := fleetTopologyNodeByID(data.Nodes, edge.To); ok && node.Status != "" {
			color = fleetStatusColor(gwtheme.Of(ctx), node.Status)
		}
		edges = append(edges, canvasEdge{From: edge.From, To: edge.To, Points: edge.Points, Color: color})
	}
	hit := func(x, y float32) bool {
		for _, node := range data.Nodes {
			if x >= node.X && x <= node.X+node.W && y >= node.Y && y <= node.Y+node.H {
				return true
			}
		}
		return false
	}
	t := gwtheme.Of(ctx)
	kit.Text(ctx, "拖拽平移 · 滚轮缩放", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	s.infiniteView(ctx, view, data.Width, data.Height, edges, hit, func(ctx *ui.Context, view *infiniteCanvas) {
		for index := range data.Nodes {
			node := data.Nodes[index]
			card := s.fleetTopologyCard(ctx, data, node)
			card.Width(node.W * view.zoom).Height(node.H * view.zoom)
			card.Absolute().Left(view.x + node.X*view.zoom).Top(view.y + node.Y*view.zoom)
		}
	})
}

func (s *shellState) fleetTopologyCard(ctx *ui.Context, data *fleetTopologyData, node fleetTopologyNode) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	agent := s.fleetTopologyAgent(data.TaskID, node.ID)
	status := node.Status
	if agent != nil && agent.Status != "" {
		status = agent.Status
	}
	module := node.Kind == "module" || node.Kind == "boundary"
	accent := fleetAccents()[1]
	if agent != nil {
		if value, ok := s.fleet.accents[agent.ID]; ok {
			accent = value
		}
	} else {
		accent = fleetStatusColor(t, status)
	}
	card := ui.Column(ctx).Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Focusable()
	card.Width(node.W).Height(node.H)
	card.Label("图节点 " + fleetTopologyNodeLabel(node))
	s.fleetHoverCard(card, node.ID, accent, t)
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		p.Fill(ui.Rect{X: r.X, Y: r.Y + 8, W: 3, H: r.H - 16}, accent, 2)
	})
	if agent != nil {
		selected := *agent
		card.OnClick(func() { s.openFleetAgentChat(selected) })
		card.ContextMenu(func(m *ui.Menu) {
			if m.Item("查看详情").Chosen() {
				_ = s.openFleetAgentPage(selected)
			}
		})
	}
	share, second := s.graphTokenShare(data, agent)
	steps := 0
	var duration int64
	if agent != nil {
		steps = agent.Requests
		duration = fleetAgentDurationMs(*agent)
	}
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(0.75)).AlignItems(ui.Center).Children(func() {
			fleetAvatar(ctx, fleetGraphInitial(fleetTopologyNodeLabel(node)), accent, th.Space(5))
			fleetStatusDot(ctx, status)
			title := fleetTopologyNodeLabel(node)
			if module {
				title = "◇ " + title
			}
			kit.Text(ctx, title, t.Text.Sm).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			if workStatusOf(status) == workRunning {
				fleetGraphPill(ctx, "当前", t.SuccessText, t.SuccessBg)
			}
		})
		first, secondLine := fleetGraphDutyLines(fleetTopologyAction(node))
		kit.Text(ctx, first, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		if secondLine != "" {
			kit.Text(ctx, secondLine, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
		model := node.Model
		if model == "" {
			model = "—"
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, shortModel(model), t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			s.definitionLink(ctx, t, node.BoundDefinition)
		})
		tokens := int64(0)
		cost := 0.0
		if agent != nil {
			tokens, cost = agent.Tokens, agent.Cost
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, formatTrajectoryCompactTokens(tokens)+" tokens", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
			kit.Text(ctx, formatTrajectoryCost(cost), t.Text.Xs).TextColor(t.Muted)
		})
		s.fleetGraphUsageBar(ctx, share, second, accent)
		ui.Row(ctx).FillWidth().AlignItems(ui.Center).Gap(th.Space(1)).Children(func() {
			meta := strconv.Itoa(steps) + " 步 · " + formatTrajectoryCompactDuration(duration)
			if agent == nil {
				meta = fleetStatusLabel(status)
			}
			kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, "占比 "+formatTrajectoryPercent(float64(share)), t.Text.Xs).FontWeight(600).TextColor(t.SuccessText)
		})
	})
	return card
}

func fleetGraphInitial(label string) string {
	runes := []rune(strings.TrimSpace(label))
	if len(runes) == 0 {
		return "?"
	}
	if len(runes) == 1 {
		return strings.ToUpper(string(runes[0]))
	}
	return strings.ToUpper(string(runes[:2]))
}

func fleetGraphDutyLines(action string) (string, string) {
	runes := []rune(strings.TrimSpace(action))
	if len(runes) <= 26 {
		return string(runes), ""
	}
	return string(runes[:26]), string(runes[26:min(52, len(runes))])
}

func fleetGraphPill(ctx *ui.Context, label string, textColor, background ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).Radius(t.Radius.Full).Background(background).Padding(0, th.Space(0.75)).
		AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, label, t.Text.Xs).FontWeight(600).TextColor(textColor)
	})
}

func (s *shellState) graphTokenShare(data *fleetTopologyData, agent *fleetAgent) (float32, float32) {
	if agent == nil || agent.Tokens <= 0 {
		return 0, 0
	}
	total := int64(0)
	for _, node := range data.Nodes {
		if matched := s.fleetTopologyAgent(data.TaskID, node.ID); matched != nil && matched.Tokens > 0 {
			total += matched.Tokens
		}
	}
	if total <= 0 {
		return 0, 0
	}
	share := float32(agent.Tokens) / float32(total)
	second := share
	if agent.Cost > 0 {
		second = min(share, float32(0.18))
	}
	return share, second
}

func (s *shellState) fleetGraphUsageBar(ctx *ui.Context, share, second float32, accent ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Box(ctx).FillWidth().Height(th.Space(1.25)).Radius(t.Radius.Full).Background(t.Border.Alpha(0.3)).Clip()
	bar.Draw(func(p *ui.Painter, r ui.Rect) {
		if share <= 0 {
			return
		}
		width := r.W * share
		p.Fill(ui.Rect{X: r.X, Y: r.Y, W: width, H: r.H}, accent, r.H/2)
		if second > 0 && second < share {
			first := r.W * second
			p.Fill(ui.Rect{X: r.X, Y: r.Y, W: first, H: r.H}, accent.Alpha(0.45), r.H/2)
		}
	})
}

func fleetTopologyNodeLabel(node fleetTopologyNode) string {
	if strings.TrimSpace(node.Label) != "" {
		return node.Label
	}
	if strings.TrimSpace(node.Action) != "" {
		return node.Action
	}
	return node.ID
}

func fleetTopologyAction(node fleetTopologyNode) string {
	if strings.TrimSpace(node.Action) != "" {
		return node.Action
	}
	if node.Kind != "" {
		return node.Kind
	}
	return "节点"
}

func (s *shellState) panelFleetGraphHeader(ctx *ui.Context, data *fleetTopologyData, unit fleetGraphUnit, threadName string, threadAgent *fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	status := "未知"
	tokens := int64(0)
	cost := 0.0
	for _, agent := range unit.Agents {
		tokens += agent.Tokens
		cost += agent.Cost
		if agent.Status != "" {
			status = agent.Status
		}
	}
	meta := fmt.Sprintf("%d 节点 · %d 边 · %s tokens · %s", len(data.Nodes), len(data.Edges), formatTrajectoryCompactTokens(tokens), formatTrajectoryCost(cost))
	if threadName != "" {
		meta = "线程 " + threadName + " · " + meta
	}
	ui.Row(ctx).FillWidth().Padding(th.Space(1.5), th.Space(2)).Gap(th.Space(2)).AlignItems(ui.Center).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border).Children(func() {
		ui.Column(ctx).Grow(1).Gap(th.Space(0.5)).Children(func() {
			kit.Text(ctx, unit.Title, t.Text.Lg).FontWeight(650).TextColor(t.Foreground).SingleLine().Ellipsis("…")
			kit.Text(ctx, meta+" · "+fleetStatusLabel(status), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		})
		if threadAgent != nil {
			selected := *threadAgent
			kit.Button(ctx, "打开线程详情", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Width(th.Space(20)).
				OnClick(func() { _ = s.openFleetAgentPage(selected) })
		}
	})
}

func (s *shellState) fleetGraphThread(unit fleetGraphUnit) (string, *fleetAgent) {
	if unit.ThreadID == "" || s.fleet.data == nil {
		return "", nil
	}
	for index, agent := range s.fleet.data.Agents {
		if agent.ID == unit.ThreadID {
			return fleetAgentLabel(agent), &s.fleet.data.Agents[index]
		}
	}
	return "", nil
}

func (s *shellState) fleetTopologyAgent(taskID, nodeID string) *fleetAgent {
	for _, data := range []*fleetSnapshot{s.fleet.data, s.fleet.global} {
		if data == nil {
			continue
		}
		for index, agent := range data.Agents {
			if agent.TaskID != taskID || (agent.NodeID != "" && agent.NodeID != nodeID) {
				continue
			}
			return &data.Agents[index]
		}
	}
	if s.fleet.global == nil && !s.fleet.globalLoading && s.fleet.globalFailed == "" {
		s.ensureGlobalFleet()
	}
	return nil
}

func (s *shellState) fleetGraphUnit(taskID string) (fleetGraphUnit, bool) {
	for _, unit := range fleetGraphUnits(s.fleet.data) {
		if unit.TaskID == taskID {
			return unit, true
		}
	}
	return fleetGraphUnit{}, false
}
