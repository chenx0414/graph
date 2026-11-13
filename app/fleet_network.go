package main

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

const (
	fleetAgentCardWidth  = 65
	fleetAgentCardHeight = 29
	fleetProjectHeight   = 26
	fleetEdgeAlpha       = 0.45
)

func (s *shellState) panelFleetNetwork(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	if len(data.Agents) == 0 {
		kit.Text(ctx, "编队还没有可展示的 Agent。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	caption := formatFleetCount(len(data.Agents)) + " 个 Agent · " +
		formatFleetCount(data.Stats.Running) + " 运行中 · " +
		formatFleetCount(len(data.Tasks)) + " 个工作项"
	kit.Text(ctx, caption, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	family := map[string]bool{}
	if s.fleet.hoverID != "" {
		family = fleetFamilyOf(data, s.fleet.hoverID)
	}
	if s.fleet.rects == nil {
		s.fleet.rects = map[string]ui.Rect{}
	}
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
	stage := ui.Column(ctx).FillWidth().Gap(th.Space(2))
	stage.Draw(func(p *ui.Painter, r ui.Rect) {
		s.drawFleetEdges(p, data, family, t)
	})
	stage.Children(func() {
		for _, agent := range fleetGlobals(data) {
			global := agent
			row := ui.Row(ctx).FillWidth().Justify(ui.Center)
			row.Children(func() {
				s.fleetAgentCard(ctx, global, family, th.Space(fleetAgentCardWidth), th.Space(fleetAgentCardHeight))
			})
		}
		agentTotal := len(data.Agents)
		for _, group := range groups {
			s.fleetGroupView(ctx, group, data, family, agentTotal)
		}
	})
	if len(s.fleet.rects) == 0 {
		ctx.After(time.Millisecond)
	}
}

func (s *shellState) drawFleetEdges(p *ui.Painter, data *fleetSnapshot, family map[string]bool, t gwtheme.Tokens) {
	for _, agent := range data.Agents {
		if agent.ParentID == "" {
			continue
		}
		parent, parentOK := s.fleet.rects[agent.ParentID]
		child, childOK := s.fleet.rects[agent.ID]
		if !parentOK || !childOK || parent.W <= 0 || child.W <= 0 {
			continue
		}
		color := s.fleet.accents[agent.ID].Alpha(fleetEdgeAlpha)
		width := float32(gwtheme.Stroke)
		highlighted := s.fleet.hoverID != "" && family[agent.ID] && family[agent.ParentID]
		if highlighted {
			color = s.fleet.accents[agent.ID].Alpha(0.95)
			width = 2
		} else if s.fleet.hoverID != "" {
			color = s.fleet.accents[agent.ID].Alpha(0.08)
		}
		points := fleetEdgePoints(parent.X+parent.W/2, parent.Y+parent.H, child.X+child.W/2, child.Y)
		for index := 1; index < len(points); index++ {
			p.Line(points[index-1][0], points[index-1][1], points[index][0], points[index][1], width, color)
		}
	}
}

func (s *shellState) fleetGroupView(ctx *ui.Context, group fleetGroup, data *fleetSnapshot, family map[string]bool, total int) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	key := fleetGroupKey(group)
	title := fleetGroupTitle(group)
	open := fleetGroupExpanded(&s.fleet, group, total)
	ui.Column(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			text := "▸"
			if open {
				text = "▾"
			}
			toggle := kit.Button(ctx, text, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			toggle.Label("展开项目 " + title)
			if open {
				toggle.Label("折叠项目 " + title)
			}
			toggle.OnClick(func() { s.toggleFleetGroup(key, !open) })
			if group.Orphan {
				kit.Text(ctx, "未归属 Agent", t.Text.Sm).TextColor(t.Muted).Grow(1)
				return
			}
			project := group.Project
			s.fleetAgentCard(ctx, project, family, th.Space(fleetAgentCardWidth), th.Space(fleetProjectHeight))
		})
		if !open {
			return
		}
		limit := fleetGroupLimit(&s.fleet, group)
		shown := group.Agents
		if len(shown) > limit {
			shown = shown[:limit]
		}
		if hidden := len(group.Agents) - len(shown); hidden > 0 {
			more := kit.Button(ctx, "显示更多 · 还有 "+strconv.Itoa(hidden)+" 个", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			more.Label("显示更多项目 " + title)
			more.OnClick(func() { s.pageFleetGroup(key) })
			more.MarginStart(th.Space(4))
		}
		if len(shown) > 0 {
			wrap := ui.Row(ctx).FillWidth().Wrap().Gap(th.Space(1)).PaddingStart(th.Space(4))
			wrap.Children(func() {
				for _, agent := range shown {
					member := agent
					s.fleetAgentCard(ctx, member, family, th.Space(fleetAgentCardWidth), th.Space(fleetAgentCardHeight))
				}
			})
		}
	})
}

func (s *shellState) fleetAgentCard(ctx *ui.Context, agent fleetAgent, family map[string]bool, width, height float32) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	accent := s.fleet.accents[agent.ID]
	card := ui.Column(ctx).Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, accent.Alpha(0.42)).Focusable()
	if width > 0 {
		card.Width(width)
	} else {
		card.FillWidth()
	}
	card.Height(height)
	card.Label("编队 Agent " + fleetAgentLabel(agent))
	hovered := card.Hovered()
	if hovered {
		s.fleet.hoverID = agent.ID
		card.Background(t.HoverTint).Border(gwtheme.Stroke, accent)
	} else if family[agent.ID] && s.fleet.hoverID != "" {
		card.Border(2, accent.Alpha(0.85))
	} else if s.fleet.hoverID != "" && !family[agent.ID] {
		card.Opacity(0.45)
	}
	card.Draw(func(p *ui.Painter, r ui.Rect) { s.fleet.rects[agent.ID] = r })
	card.OnClick(func() { _ = s.openFleetAgentPage(agent) })
	card.Children(func() {
		s.fleetAgentCardHead(ctx, agent, accent)
		role := fleetAgentRole(agent)
		if agent.Kind != "" && agent.Kind != "node" {
			role = agent.Kind + " · " + role
		}
		fleetEllipsis(ctx, role, t.Text.Xs, accent)
		fleetEllipsis(ctx, fleetCardDuty(agent), t.Text.Xs, t.Muted)
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

func (s *shellState) fleetAgentCardHead(ctx *ui.Context, agent fleetAgent, accent ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		avatar := ui.Box(ctx).Size(th.Space(6), th.Space(6)).Radius(t.Radius.Full).Center().
			Background(accent.Alpha(0.22)).Border(gwtheme.Stroke, accent.Alpha(0.5))
		avatar.Children(func() {
			kit.Text(ctx, fleetAgentInitial(agent), t.Text.Xs).FontWeight(700).TextColor(accent)
		})
		fleetStatusDot(ctx, agent.Status)
		kit.Text(ctx, fleetAgentLabel(agent), t.Text.Sm).FontWeight(650).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
		if agent.Model != "" {
			kit.Text(ctx, shortModel(agent.Model), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
	})
}

func (s *shellState) fleetUsageBar(ctx *ui.Context, agent fleetAgent, accent ui.Color) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	track := t.Border.Alpha(0.35)
	bar := ui.Box(ctx).FillWidth().Height(th.Space(1.5)).Radius(t.Radius.Full).Background(track).Clip()
	bar.Draw(func(p *ui.Painter, r ui.Rect) {
		share := float32(s.fleet.shares[agent.ID])
		if share <= 0 {
			return
		}
		p.Fill(ui.Rect{X: r.X, Y: r.Y, W: r.W * share, H: r.H}, accent, r.H/2)
	})
}

func fleetCardDuty(agent fleetAgent) string {
	operation := strings.TrimSpace(fleetOperation(agent))
	if operation == "" || operation == "—" {
		operation = "等待下一次派单"
	}
	return "当前 · " + operation
}

func fleetEdgePoints(x1, y1, x2, y2 float32) [][2]float32 {
	k := float32(math.Min(96, math.Max(24, float64((y2-y1)*0.5))))
	points := make([][2]float32, 0, 17)
	for index := 0; index <= 16; index++ {
		t := float32(index) / 16
		mt := 1 - t
		x := mt*mt*mt*x1 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x2
		y := mt*mt*mt*y1 + 3*mt*mt*t*(y1+k) + 3*mt*t*t*(y2-k) + t*t*t*y2
		points = append(points, [2]float32{x, y})
	}
	return points
}
