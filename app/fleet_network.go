package main

import (
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

const (
	fleetRingEdgeAlpha = 0.32
	fleetRingAxisAlpha = 0.16
)

func (s *shellState) panelFleetNetwork(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	if len(data.Agents) == 0 {
		kit.Text(ctx, "编队还没有可展示的 Agent。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	ring := fleetRingLayout(data)
	s.fleetNetworkModels(data)
	s.fleetHoverScope(s.boardPage().ID + "/network")
	caption := formatFleetCount(len(data.Agents)) + " 个 Agent · " +
		formatFleetCount(data.Stats.Running) + " 运行中 · Main 中心 · Thread 环 · Graph 环"
	kit.Text(ctx, caption, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	ui.ScrollBoth(ctx).Fill().TrackScroll(&s.fleet.netScroll).Children(func() {
		world := ui.Box(ctx).Width(ring.Width).Height(ring.Height)
		world.Draw(func(p *ui.Painter, r ui.Rect) {
			s.drawFleetRing(p, r.X, r.Y, ring, t)
		})
		world.Children(func() {
			for _, node := range ring.Nodes {
				positioned := node
				switch positioned.Kind {
				case "global", "thread", "orphan", "graph-unit", "graph-aggregate":
				default:
					continue
				}
				element := s.fleetRingElement(ctx, positioned)
				element.Absolute().Left(positioned.X).Top(positioned.Y)
			}
		})
	})
}

func (s *shellState) fleetNetworkModels(data *fleetSnapshot) {
	accents := fleetAccents()
	groups := fleetGroups(data)
	groupAt := make(map[string]int, len(data.Agents))
	for index, group := range groups {
		if !group.Orphan {
			groupAt[group.Project.ID] = index
		}
		for _, agent := range group.Agents {
			groupAt[agent.ID] = index
		}
	}
	total := int64(0)
	for _, agent := range data.Agents {
		if agent.Tokens > 0 {
			total += agent.Tokens
		}
	}
	s.fleet.accents = make(map[string]ui.Color, len(data.Agents))
	s.fleet.shares = make(map[string]float64, len(data.Agents))
	for _, agent := range data.Agents {
		index, ok := groupAt[agent.ID]
		accent := accents[1]
		switch {
		case agent.Kind == "global":
			accent = accents[0]
		case ok:
			accent = accents[(index+1)%len(accents)]
		}
		s.fleet.accents[agent.ID] = accent
		if total > 0 && agent.Tokens > 0 {
			s.fleet.shares[agent.ID] = float64(agent.Tokens) / float64(total)
		}
	}
}

func (s *shellState) drawFleetRing(p *ui.Painter, x, y float32, ring fleetRing, t gwtheme.Tokens) {
	s.fleetRingEllipse(p, x, y, ring, ring.Ring1X, ring.Ring1Y, t.Border.Alpha(fleetRingAxisAlpha))
	s.fleetRingEllipse(p, x, y, ring, ring.Ring2X, ring.Ring2Y, t.Border.Alpha(fleetRingAxisAlpha))
	label := t.Muted.Alpha(0.7)
	p.Text(x+12, y+ring.Height-26, "Thread Agent", t.Text.Xs, label)
	p.Text(x+12, y+ring.Height-40, "Graph Agent", t.Text.Xs, label)
	for _, edge := range ring.Edges {
		color, ok := s.fleet.accents[edge.ToID]
		if !ok {
			color = s.fleet.accents[edge.FromID]
		}
		width, alpha := fleetEdgePaint(edge.FromID, edge.ToID, s.fleet.hoverID, float32(gwtheme.Stroke), float32(fleetRingEdgeAlpha))
		points := make([][2]float32, len(edge.Points))
		for index, point := range edge.Points {
			points[index] = [2]float32{x + point[0], y + point[1]}
		}
		p.StrokePolyline(points, width, color.Alpha(alpha))
	}
}

func (s *shellState) fleetRingEllipse(p *ui.Painter, x, y float32, ring fleetRing, rx, ry float32, color ui.Color) {
	points := make([][2]float32, 0, 97)
	for index := 0; index <= 96; index++ {
		angle := 2 * math.Pi * float64(index) / 96
		points = append(points, [2]float32{
			x + ring.CX + rx*float32(math.Cos(angle)),
			y + ring.CY + ry*float32(math.Sin(angle)),
		})
	}
	p.StrokePolyline(points, 1, color)
}

func (s *shellState) fleetRingElement(ctx *ui.Context, node fleetRingNode) ui.Element {
	switch node.Kind {
	case "global":
		return s.fleetAgentCard(ctx, node.Agent, node.W, node.H)
	case "thread":
		return s.fleetThreadCard(ctx, node)
	case "orphan":
		return s.fleetOrphanCard(ctx, node)
	case "graph-unit", "graph-aggregate":
		return s.fleetGraphUnitCard(ctx, node)
	}
	return ui.Element{}
}

func (s *shellState) fleetAgentCard(ctx *ui.Context, agent fleetAgent, width, height float32) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	accent := s.fleet.accents[agent.ID]
	card := ui.Column(ctx).Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Focusable()
	card.Width(width).Height(height)
	card.Label("编队 Agent " + fleetAgentLabel(agent))
	s.fleetHoverCard(card, agent.ID, accent, t)
	card.OnClick(func() { s.openFleetAgentChat(agent) })
	s.fleetAgentDetailMenu(card, agent)
	card.Children(func() {
		s.fleetAgentCardHead(ctx, agent, accent)
		fleetEllipsis(ctx, fleetAgentRole(agent), t.Text.Xs, accent)
		fleetEllipsis(ctx, "当前 · "+fleetOperation(agent), t.Text.Xs, t.Muted)
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, formatTrajectoryCompactTokens(agent.Tokens)+" tokens", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
			kit.Text(ctx, formatTrajectoryCost(agent.Cost), t.Text.Xs).TextColor(t.Muted)
			ui.Spacer(ctx)
			kit.Text(ctx, fleetStatusLabel(agent.Status), t.Text.Xs).TextColor(fleetStatusColor(t, agent.Status))
		})
		s.fleetUsageBar(ctx, agent, accent)
		steps := fleetAgentSteps(agent)
		share := s.fleet.shares[agent.ID]
		bottom := strconv.Itoa(steps) + " 步 · " + formatTrajectoryCompactDuration(fleetAgentDurationMs(agent)) + " · 占比 " + formatTrajectoryPercent(share)
		kit.Text(ctx, bottom, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
	})
	return card
}

func (s *shellState) fleetThreadCard(ctx *ui.Context, node fleetRingNode) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	agent := node.Agent
	accent := s.fleetRingAccent(node)
	card := ui.Column(ctx).Clip().Padding(th.Space(0.75), th.Space(1)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Focusable()
	card.Width(node.W).Height(node.H)
	if node.Aggregate {
		card.Label("编队其他项目 " + node.Detail)
		card.Tooltip(node.Detail)
	} else {
		card.Label("编队 Agent " + fleetAgentLabel(agent))
		card.OnClick(func() { s.openFleetAgentChat(agent) })
		s.fleetAgentDetailMenu(card, agent)
	}
	s.fleetHoverCard(card, node.ID, accent, t)
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(0.75)).AlignItems(ui.Center).Children(func() {
			fleetAvatar(ctx, fleetAgentInitial(agent), accent, th.Space(4.5))
			if !node.Aggregate {
				fleetStatusDot(ctx, agent.Status)
			}
			kit.Text(ctx, fleetThreadTitle(node), t.Text.Xs).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
		})
		switch {
		case node.H >= 80:
			fleetEllipsis(ctx, strconv.Itoa(node.Count)+" 个图 · "+formatTrajectoryCompactTokens(agent.Tokens), t.Text.Xs, t.Muted)
			s.fleetUsageBar(ctx, agent, accent)
			bottom := strconv.Itoa(fleetAgentSteps(agent)) + " 步 · 占比 " + formatTrajectoryPercent(s.fleet.shares[agent.ID])
			kit.Text(ctx, bottom, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
		case node.H >= 48:
			fleetEllipsis(ctx, strconv.Itoa(node.Count)+" 个图", t.Text.Xs, t.Muted)
		}
	})
	return card
}

func (s *shellState) fleetAgentDetailMenu(card ui.Element, agent fleetAgent) {
	selected := agent
	card.ContextMenu(func(m *ui.Menu) {
		if m.Item("查看详情").Chosen() {
			_ = s.openFleetAgentPage(selected)
		}
	})
}

func fleetThreadTitle(node fleetRingNode) string {
	if node.Aggregate {
		return node.Detail
	}
	return fleetAgentLabel(node.Agent)
}

func (s *shellState) fleetRingAccent(node fleetRingNode) ui.Color {
	if node.Kind == "orphan" {
		return fleetAccents()[1]
	}
	if accent, ok := s.fleet.accents[node.Agent.ID]; ok {
		return accent
	}
	accents := fleetAccents()
	return accents[(node.Group+1)%len(accents)]
}

func (s *shellState) fleetOrphanCard(ctx *ui.Context, node fleetRingNode) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	accent := fleetAccents()[1]
	card := ui.Column(ctx).Clip().Padding(th.Space(0.75), th.Space(1)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Justify(ui.Center)
	card.Width(node.W).Height(node.H)
	s.fleetHoverCard(card, node.ID, accent, t)
	card.Children(func() {
		kit.Text(ctx, "未归属", t.Text.Xs).FontWeight(600).TextColor(t.Muted).SingleLine().Ellipsis("…")
		kit.Text(ctx, strconv.Itoa(node.Count)+" 个图", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	})
	return card
}

func (s *shellState) fleetGraphUnitCard(ctx *ui.Context, node fleetRingNode) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	unit := node.Unit
	accent := fleetAccents()[0]
	if agent, ok := s.fleet.accents[unit.ThreadID]; ok {
		accent = agent
	}
	card := ui.Column(ctx).Clip().Padding(th.Space(0.5), th.Space(1.25)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Focusable()
	card.Width(node.W).Height(node.H)
	if unit.Aggregate {
		card.Label("编队图 " + unit.Title)
		card.Tooltip(unit.Title + " · " + unit.Detail)
	} else {
		card.Label("编队图 " + unit.Title)
		card.Tooltip(unit.Title + " · " + strconv.Itoa(unit.NodeCount) + " 节点")
		selected := unit
		card.OnClick(func() { _ = s.openFleetGraphPage(selected) })
	}
	s.fleetHoverCard(card, node.ID, accent, t)
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(0.75)).AlignItems(ui.Center).Children(func() {
			fleetStatusDot(ctx, unit.Status)
			kit.Text(ctx, unit.Title, t.Text.Xs).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
		})
		meta := strconv.Itoa(unit.NodeCount) + " 节点"
		if unit.Status != "" {
			meta += " · " + fleetStatusLabel(unit.Status)
		}
		if unit.Tokens > 0 {
			meta += " · " + formatTrajectoryCompactTokens(unit.Tokens)
		}
		kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
	})
	return card
}

func fleetAvatar(ctx *ui.Context, initial string, accent ui.Color, size float32) ui.Element {
	t := gwtheme.Of(ctx)
	avatar := ui.Box(ctx).Size(size, size).Radius(t.Radius.Full).Center().
		Background(accent.Alpha(0.22)).Border(gwtheme.Stroke, accent.Alpha(0.5))
	avatar.Children(func() {
		kit.Text(ctx, initial, t.Text.Xs).FontWeight(700).TextColor(accent)
	})
	return avatar
}

func (s *shellState) fleetAgentCardHead(ctx *ui.Context, agent fleetAgent, accent ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		fleetAvatar(ctx, fleetAgentInitial(agent), accent, th.Space(6))
		fleetStatusDot(ctx, agent.Status)
		kit.Text(ctx, fleetAgentLabel(agent), t.Text.Sm).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
		if agent.Model != "" {
			kit.Text(ctx, shortModel(agent.Model), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
	})
}

func (s *shellState) fleetUsageBar(ctx *ui.Context, agent fleetAgent, accent ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Box(ctx).FillWidth().Height(th.Space(1)).Radius(t.Radius.Full).Background(t.Border.Alpha(0.35)).Clip()
	bar.Draw(func(p *ui.Painter, r ui.Rect) {
		share := float32(s.fleet.shares[agent.ID])
		if share <= 0 {
			return
		}
		p.Fill(ui.Rect{X: r.X, Y: r.Y, W: r.W * share, H: r.H}, accent, r.H/2)
	})
}
