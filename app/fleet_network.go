package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
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
	index := fleetIndex(data)
	caption := formatFleetCount(len(data.Agents)) + " 个 Agent · " +
		formatFleetCount(data.Stats.Running) + " 运行中 · " +
		formatFleetCount(len(data.Tasks)) + " 个工作项"
	kit.Text(ctx, caption, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	family := map[string]bool{}
	if s.fleet.hoverID != "" {
		family = fleetFamilyOf(data, s.fleet.hoverID)
	}
	if agent, ok := index[s.fleet.selectedID]; ok {
		s.fleetNodeWindow(ctx, agent)
	}
	for _, agent := range fleetGlobals(data) {
		s.fleetAgentCard(ctx, agent, family, true)
	}
	groups := fleetGroups(data)
	if len(groups) == 0 {
		return
	}
	total := len(data.Agents)
	trunk := ui.Column(ctx).FillWidth().Gap(th.Space(2))
	trunk.Draw(func(p *ui.Painter, r ui.Rect) {
		x := r.X + th.Space(2)
		p.Line(x, r.Y, x, r.Y+r.H, gwtheme.Stroke, t.Border)
	})
	trunk.Children(func() {
		for _, group := range groups {
			s.fleetGroupView(ctx, group, family, total)
		}
	})
}

func (s *shellState) fleetGroupView(ctx *ui.Context, group fleetGroup, family map[string]bool, total int) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	key := fleetGroupKey(group)
	title := fleetGroupTitle(group)
	open := fleetGroupExpanded(&s.fleet, group, total)
	ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
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
			s.fleetProjectCard(ctx, group, family)
		})
		if !open {
			return
		}
		limit := fleetGroupLimit(&s.fleet, group)
		shown := group.Agents
		if len(shown) > limit {
			shown = shown[:limit]
		}
		childHeight := th.Space(18)
		pitch := childHeight + th.Space(1)
		hidden := len(group.Agents) - len(shown)
		if hidden > 0 {
			more := kit.Button(ctx, "显示更多 · 还有 "+strconv.Itoa(hidden)+" 个", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			more.Label("显示更多项目 " + title)
			more.OnClick(func() { s.pageFleetGroup(key) })
			more.MarginStart(th.Space(5))
		}
		children := ui.Column(ctx).FillWidth().PaddingStart(th.Space(5))
		children.Draw(func(p *ui.Painter, r ui.Rect) {
			spine := r.X - th.Space(3)
			for index := range shown {
				y := r.Y + float32(index)*pitch + childHeight/2
				p.Line(spine, y, r.X, y, gwtheme.Stroke, t.Border)
			}
		})
		children.Children(func() {
			for index := range shown {
				agent := shown[index]
				ui.Column(ctx).FillWidth().Height(pitch).Children(func() {
					card := s.fleetAgentCard(ctx, agent, family, false)
					card.Height(childHeight - th.Space(1))
				})
			}
		})
	})
}

func (s *shellState) fleetProjectCard(ctx *ui.Context, group fleetGroup, family map[string]bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	agent := group.Project
	title := fleetGroupTitle(group)
	if group.Orphan {
		kit.Text(ctx, "未归属 Agent", t.Text.Sm).TextColor(t.Foreground).Grow(1)
		return
	}
	card := ui.Column(ctx).Grow(1).Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border).Focusable()
	card.Label("编队 Agent " + title)
	hovered := card.Hovered()
	if hovered {
		s.fleet.hoverID = agent.ID
		card.Background(t.HoverTint).Border(gwtheme.Stroke, t.Unread)
	} else if family[agent.ID] && s.fleet.hoverID != "" {
		card.Border(gwtheme.Stroke, t.Unread.Alpha(0.55))
	}
	card.OnClick(func() { s.openFleetAgent(agent) })
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			fleetStatusDot(ctx, agent.Status)
			kit.Text(ctx, title, t.Text.Sm).FontWeight(600).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, strconv.Itoa(len(group.Agents))+" 个 Agent", t.Text.Xs).TextColor(t.Muted)
		})
		meta := []string{fleetAgentRole(agent)}
		if agent.Model != "" {
			meta = append(meta, shortModel(agent.Model))
		}
		meta = append(meta, formatTrajectoryCompactTokens(agent.Tokens)+" tokens", formatTrajectoryCost(agent.Cost), fleetOperation(agent))
		fleetEllipsis(ctx, joinFleetMeta(meta), t.Text.Xs, t.Muted)
	})
}

func (s *shellState) fleetAgentCard(ctx *ui.Context, agent fleetAgent, family map[string]bool, global bool) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).FillWidth().Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border).Focusable()
	card.Label("编队 Agent " + fleetAgentLabel(agent))
	hovered := card.Hovered()
	if hovered {
		s.fleet.hoverID = agent.ID
		card.Background(t.HoverTint).Border(gwtheme.Stroke, t.Unread)
	} else if family[agent.ID] && s.fleet.hoverID != "" {
		card.Border(gwtheme.Stroke, t.Unread.Alpha(0.55))
	}
	card.OnClick(func() { s.openFleetAgent(agent) })
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			fleetStatusDot(ctx, agent.Status)
			kit.Text(ctx, fleetAgentLabel(agent), t.Text.Sm).FontWeight(600).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, fleetStatusLabel(agent.Status), t.Text.Xs).TextColor(t.Muted)
		})
		meta := []string{fleetAgentRole(agent)}
		if global || agent.Kind != "node" {
			if agent.Model != "" {
				meta = append(meta, shortModel(agent.Model))
			}
		}
		if agent.Model != "" && agent.Kind == "node" {
			meta = append(meta, shortModel(agent.Model))
		}
		meta = append(meta, formatTrajectoryCompactTokens(agent.Tokens)+" tokens", formatTrajectoryCost(agent.Cost))
		fleetEllipsis(ctx, joinFleetMeta(meta), t.Text.Xs, t.Muted)
		fleetEllipsis(ctx, "当前操作 · "+fleetOperation(agent), t.Text.Xs, t.Muted)
	})
	return card
}

func (s *shellState) fleetNodeWindow(ctx *ui.Context, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).FillWidth().Clip().Padding(th.Space(1.5), th.Space(2)).Gap(th.Space(0.5)).
		Radius(t.Radius.Lg).Background(t.Background).Border(gwtheme.Stroke, t.Unread.Alpha(0.55))
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, "节点窗口 · "+fleetAgentLabel(agent), t.Text.Sm).FontWeight(600).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			closeButton := kit.Button(ctx, "关闭", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			closeButton.Label("关闭节点窗口")
			closeButton.OnClick(func() {
				s.fleet.selectedID = ""
				s.frame()
			})
		})
		fleetEllipsis(ctx, "角色 "+fleetAgentRole(agent)+" · 状态 "+fleetStatusLabel(agent.Status)+" · 模型 "+shortModel(agent.Model), t.Text.Xs, t.Muted)
		idLine := "Tokens " + formatTrajectoryCompactTokens(agent.Tokens) + " · 成本 " + formatTrajectoryCost(agent.Cost) + " · 请求 " + strconv.Itoa(agent.Requests) + " 次 · 消息 " + strconv.Itoa(agent.Messages) + " 条"
		fleetEllipsis(ctx, idLine, t.Text.Xs, t.Muted)
		if agent.TaskID != "" || agent.NodeID != "" {
			fleetEllipsis(ctx, "任务 "+agent.TaskID+" · 节点 "+agent.NodeID, t.Text.Xs, t.Muted)
		}
		fleetEllipsis(ctx, "当前操作 · "+fleetOperation(agent), t.Text.Xs, t.Muted)
	})
}

func fleetGroupKey(group fleetGroup) string {
	if group.Orphan {
		return "orphans"
	}
	return group.Project.ID
}

func joinFleetMeta(parts []string) string {
	out := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if out != "" {
			out += " · "
		}
		out += part
	}
	return out
}
