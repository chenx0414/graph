package main

import (
	"fmt"
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
	if state.loading {
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
	if data.Width <= 820 && data.Height <= 620 {
		ui.Column(ctx).FillWidth().Grow(1).Justify(ui.Center).Children(func() {
			ui.Row(ctx).FillWidth().Justify(ui.Center).Children(func() {
				s.fleetGraphCanvas(ctx, data)
			})
		})
		return
	}
	ui.ScrollBoth(ctx).Fill().Children(func() {
		s.fleetGraphCanvas(ctx, data)
	})
}

func (s *shellState) fleetGraphMessage(ctx *ui.Context, text string, color ui.Color) {
	t := gwtheme.Of(ctx)
	ui.Column(ctx).FillWidth().Grow(1).Justify(ui.Center).Children(func() {
		kit.Text(ctx, text, t.Text.Sm).TextColor(color)
	})
}

func (s *shellState) fleetGraphCanvas(ctx *ui.Context, data *fleetTopologyData) {
	world := ui.Box(ctx).Width(data.Width).Height(data.Height)
	world.Draw(func(p *ui.Painter, r ui.Rect) {
		for _, edge := range data.Edges {
			if len(edge.Points) < 2 {
				continue
			}
			color, _ := fleetTopologyNodeByID(data.Nodes, edge.To)
			accent := fleetStatusColor(gwtheme.Of(ctx), color.Status)
			if agent := s.fleetTopologyAgent(data.TaskID, edge.To); agent != nil {
				if value, ok := s.fleet.accents[agent.ID]; ok {
					accent = value
				}
			}
			points := make([][2]float32, len(edge.Points))
			for index, point := range edge.Points {
				points[index] = [2]float32{r.X + point[0], r.Y + point[1]}
			}
			p.StrokePolyline(points, 2, accent.Alpha(0.85))
		}
	})
	world.Children(func() {
		for index := range data.Nodes {
			node := data.Nodes[index]
			card := s.fleetTopologyCard(ctx, data, node)
			card.Absolute().Left(node.X).Top(node.Y)
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
	accent := fleetAccents()[1]
	module := node.Kind == "module" || node.Kind == "boundary"
	if module {
		accent = fleetAccents()[1]
	}
	if agent != nil {
		if value, ok := s.fleet.accents[agent.ID]; ok {
			accent = value
		}
	}
	card := ui.Column(ctx).Clip().Padding(th.Space(1.25), th.Space(1.75)).Gap(th.Space(0.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, accent.Alpha(0.45)).Focusable()
	card.Width(node.W).Height(node.H)
	card.Label("图节点 " + fleetTopologyNodeLabel(node))
	card.Draw(func(p *ui.Painter, r ui.Rect) {
		p.Fill(ui.Rect{X: r.X, Y: r.Y + 8, W: 3, H: r.H - 16}, accent, 2)
	})
	if agent != nil {
		selected := *agent
		card.OnClick(func() { _ = s.openFleetAgentPage(selected) })
	}
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			fleetAvatar(ctx, fleetAgentInitial(fleetAgent{Name: fleetTopologyNodeLabel(node)}), accent, th.Space(5))
			fleetStatusDot(ctx, status)
			title := fleetTopologyNodeLabel(node)
			if module {
				title = "◇ " + title
			}
			kit.Text(ctx, title, t.Text.Sm).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
		})
		fleetEllipsis(ctx, fleetTopologyAction(node), t.Text.Xs, t.Muted)
		meta := fleetStatusLabel(status)
		if node.Model != "" {
			meta += " · " + shortModel(node.Model)
		}
		if agent != nil {
			meta += " · " + formatTrajectoryCompactTokens(agent.Tokens)
			if agent.Cost > 0 {
				meta += " · " + formatTrajectoryCost(agent.Cost)
			}
		}
		kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
	})
	return card
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
	ui.Column(ctx).FillWidth().Padding(th.Space(1.5), th.Space(2)).Gap(th.Space(0.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border).Children(func() {
		kit.Text(ctx, unit.Title, t.Text.Lg).FontWeight(650).TextColor(t.Foreground).MaxWidth(560).SingleLine().Ellipsis("…")
		kit.Text(ctx, meta+" · "+fleetStatusLabel(status), t.Text.Xs).TextColor(t.Muted).MaxWidth(700).SingleLine().Ellipsis("…")
		if threadAgent != nil {
			selected := *threadAgent
			kit.Button(ctx, "打开线程详情", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).OnClick(func() { _ = s.openFleetAgentPage(selected) })
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
