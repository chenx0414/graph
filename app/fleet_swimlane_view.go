package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) panelFleetCollaboration(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.fleet.data == nil {
		if !s.fleetUnavailable(ctx) {
			skeletonFleetRows(ctx, 5)
		}
		return
	}
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	model := buildFleetSwimlane(data, s.fleet.swimQuery, s.fleet.swimNewest)
	if model.Total == 0 {
		kit.Text(ctx, "还没有跨 Agent 协作事件。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
		ui.Icon(ctx, iconNetwork).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
		kit.Text(ctx, "跨 Agent 协作", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		kit.Text(ctx, strconv.Itoa(model.Records)+"/"+strconv.Itoa(model.Total)+" 条记录 · "+strconv.Itoa(len(model.Lanes))+" 条泳道", t.Text.Xs).TextColor(t.Muted)
		ui.Spacer(ctx)
		fleetChip(ctx, "最早", "最早", !s.fleet.swimNewest, func() {
			s.fleet.swimNewest = false
			s.frame()
		})
		fleetChip(ctx, "最新", "最新", s.fleet.swimNewest, func() {
			s.fleet.swimNewest = true
			s.frame()
		})
		input := kit.Input(ctx, &s.fleet.swimQuery, kit.InputOpts{Placeholder: "搜索 Agent…", Flat: true})
		input.Width(th.Space(26)).Label("搜索 Agent")
	})
	if len(model.Marks) == 0 {
		kit.Text(ctx, "没有匹配的协作事件。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(2)).Children(func() {
		s.fleetSwimLaneRail(ctx, t, model)
		s.fleetSwimGrid(ctx, t, model)
	})
	if s.fleet.swimPick != "" {
		s.fleetSwimPicked(ctx, t, model)
	}
}

func (s *shellState) fleetSwimLaneRail(ctx *ui.Context, t gwtheme.Tokens, model fleetSwimlane) {
	th := ctx.Theme()
	ui.Column(ctx).Width(th.Space(fleetSwimRailWidth / 4)).Gap(0).Children(func() {
		ui.Box(ctx).Height(th.Space(fleetSwimHeadHeight / 4))
		for _, lane := range model.Lanes {
			lane := lane
			row := ui.Row(ctx).FillWidth().Height(th.Space(fleetSwimLaneHeight / 4)).Gap(th.Space(1)).AlignItems(ui.Center)
			row.Children(func() {
				fleetAvatar(ctx, fleetAgentInitial(lane.Agent), lane.Accent, th.Space(4.5))
				ui.Column(ctx).Grow(1).Gap(0).Children(func() {
					kit.Text(ctx, fleetAgentLabel(lane.Agent), t.Text.Xs).FontWeight(650).TextColor(t.Foreground).SingleLine().Ellipsis("…")
					kit.Text(ctx, fleetAgentModelLabel(lane.Agent), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
					kit.Text(ctx, formatTrajectoryCompactTokens(lane.Agent.Tokens)+" · "+formatTrajectoryCost(lane.Agent.Cost), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
					kit.Text(ctx, strconv.Itoa(lane.Tasks)+" 个任务 · "+strconv.Itoa(lane.Events)+" 个事件", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
				})
			})
		}
	})
}

func fleetAgentModelLabel(agent fleetAgent) string {
	if agent.Model == "" {
		return fleetAgentRole(agent)
	}
	return agent.Model
}

func (s *shellState) fleetSwimGrid(ctx *ui.Context, t gwtheme.Tokens, model fleetSwimlane) {
	th := ctx.Theme()
	head := th.Space(fleetSwimHeadHeight / 4)
	laneHeight := th.Space(fleetSwimLaneHeight / 4)
	columnWidth := th.Space(fleetSwimColumnWidth / 4)
	width := float32(len(model.Columns)) * columnWidth
	height := head + float32(len(model.Lanes))*laneHeight
	ui.ScrollHorizontal(ctx).Grow(1).Children(func() {
		stage := ui.Box(ctx).Width(width).Height(height).Clip().Label("协作时间列")
		stage.Draw(func(p *ui.Painter, r ui.Rect) {
			for at := 0; at <= len(model.Lanes); at++ {
				y := r.Y + head + float32(at)*laneHeight
				p.Fill(ui.Rect{X: r.X, Y: y, W: r.W, H: 1}, t.Border.Alpha(0.55), 0)
			}
			for at := 1; at < len(model.Columns); at++ {
				x := r.X + float32(at)*columnWidth
				p.Fill(ui.Rect{X: x, Y: r.Y + head, W: 1, H: r.H - head}, t.Border.Alpha(0.3), 0)
			}
			center := func(lane int) float32 {
				return r.Y + head + float32(lane)*laneHeight + laneHeight/2
			}
			for _, mark := range model.Marks {
				if mark.From < 0 || mark.To < 0 || mark.From == mark.To {
					continue
				}
				x := r.X + float32(mark.Column)*columnWidth + columnWidth/2
				color := model.Lanes[mark.From].Accent
				from, to := center(mark.From), center(mark.To)
				if from > to {
					from, to = to, from
				}
				p.Fill(ui.Rect{X: x - 1, Y: from, W: 2, H: to - from}, color.Alpha(0.6), 1)
				p.Fill(ui.Rect{X: x - 3, Y: from + (to - from) - 5, W: 6, H: 5}, color.Alpha(0.9), 1.5)
			}
		})
		stage.Children(func() {
			for at, column := range model.Columns {
				x := float32(at) * columnWidth
				accent := model.Lanes[0].Accent
				for _, mark := range model.Marks {
					if mark.Column == at && mark.From >= 0 {
						accent = model.Lanes[mark.From].Accent
						break
					}
				}
				ui.Row(ctx).Gap(th.Space(0.5)).AlignItems(ui.Center).Absolute().
					Left(x + columnWidth/2 - th.Space(3)).Top(th.Space(0.5)).Children(func() {
					ui.Box(ctx).Size(th.Space(1.25), th.Space(1.25)).Radius(th.Space(0.75)).Background(accent)
					kit.Text(ctx, strconv.Itoa(column.Count), t.Text.Xs).TextColor(t.Muted)
				})
			}
			for _, mark := range model.Marks {
				mark := mark
				if mark.From < 0 {
					continue
				}
				half := th.Space(fleetSwimMarkSize/4) / 2
				x := float32(mark.Column)*columnWidth + columnWidth/2 - half
				y := head + float32(mark.From)*laneHeight + laneHeight/2 - half
				color := model.Lanes[mark.From].Accent
				chip := ui.Box(ctx).Size(half*2, half*2).Radius(th.Space(1)).
					Background(color.Alpha(0.9)).Border(1, color).Center().Focusable().
					Label("协作事件 " + mark.ID)
				chip.Tooltip(fleetSwimMarkLabel(mark, model) + " · " + mark.Text)
				chip.OnClick(func() {
					s.fleet.swimPick = mark.ID
					s.frame()
				})
				if s.fleet.swimPick == mark.ID {
					chip.Border(2, t.Foreground)
				}
				chip.Children(func() {
					kit.Text(ctx, fleetSwimGlyph(mark.Kind), 9).TextColor(t.OnSolid).FontWeight(700)
				})
				chip.Absolute().Left(x).Top(y)
			}
		})
	})
}

func (s *shellState) fleetSwimPicked(ctx *ui.Context, t gwtheme.Tokens, model fleetSwimlane) {
	th := ctx.Theme()
	for _, mark := range model.Marks {
		if mark.ID != s.fleet.swimPick {
			continue
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Padding(th.Space(1), th.Space(1.5)).
			Radius(t.Radius.Md).Background(t.Raised).Children(func() {
			kit.Text(ctx, fleetCategoryLabel(mark.Kind), t.Text.Xs).TextColor(t.Primary)
			kit.Text(ctx, fleetSwimMarkLabel(mark, model), t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, mark.Text, t.Text.Sm).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, formatTrajectoryClock(mark.At), t.Text.Xs).TextColor(t.Muted)
		})
		return
	}
}

func fleetSwimGlyph(kind string) string {
	switch kind {
	case "result":
		return "✓"
	case "question":
		return "?"
	}
	return "+"
}
