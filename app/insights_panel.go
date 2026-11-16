package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) insightsData(ctx *ui.Context) *trajectoryInsights {
	t := gwtheme.Of(ctx)
	state := &s.insights
	if state.data != nil {
		return state.data
	}
	if state.failed != "" {
		kit.Text(ctx, state.failed, t.Text.Sm).TextColor(t.Muted)
	} else {
		skeletonCard(ctx, 2, false, true)
	}
	if !state.loading() && state.failed == "" {
		go s.ensureInsights()
	}
	return nil
}

func (s *shellState) insightsKPICard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.insightsData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		ui.Icon(ctx, iconTrend).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
		ui.Spacer(ctx)
		label := func(days int) string {
			if s.insightsDays() == days {
				return "● " + strconv.Itoa(days) + " 天"
			}
			return "○ " + strconv.Itoa(days) + " 天"
		}
		if kit.Button(ctx, label(7), kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.setInsightsDays(7)
		}
		if kit.Button(ctx, label(30), kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			s.setInsightsDays(30)
		}
	})
	trajectoryStatGrid(ctx, [][][2]string{
		{{"总 tokens", formatTrajectoryTokens(totals.Tokens)}, {"成本", formatTrajectoryCost(totals.Cost)}, {"请求", strconv.Itoa(totals.Requests)}},
		{{"缓存命中", formatTrajectoryPercent(totals.CacheHitRate)}, {"会话", strconv.Itoa(totals.Sessions)}, {"日均 tokens", formatTrajectoryCompactTokens(averageInsightTokens(data))}},
	})
}

func averageInsightTokens(data *trajectoryInsights) int64 {
	if len(data.Days) == 0 {
		return 0
	}
	return data.Totals.Tokens / int64(len(data.Days))
}

func (s *shellState) insightsDaysCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.insightsData(ctx)
	if data == nil {
		return
	}
	peak := int64(0)
	for _, day := range data.Days {
		if day.Tokens > peak {
			peak = day.Tokens
		}
	}
	trajectoryCardHeader(ctx, iconTrend, formatTrajectoryCompactTokens(data.Totals.Tokens))
	chartHeight := th.Space(8)
	chart := ui.Row(ctx).FillWidth().Height(chartHeight).Gap(th.Space(1)).AlignItems(ui.End).Clip()
	chart.Children(func() {
		for _, day := range data.Days {
			ratio := float32(0)
			if peak > 0 {
				ratio = float32(day.Tokens) / float32(peak)
			}
			height := float32(2) + ratio*(chartHeight-4)
			ui.Box(ctx).Grow(1).Height(height).Radius(t.Radius.Xs).Background(palette.Blue500.Color().Alpha(0.75))
		}
	})
	labels := ui.Row(ctx).FillWidth().Gap(th.Space(1))
	step := 1
	if len(data.Days) > 8 {
		step = (len(data.Days) + 6) / 7
	}
	labels.Children(func() {
		for index, day := range data.Days {
			label := ""
			if index%step == 0 || index == len(data.Days)-1 {
				label = formatInsightDate(day.Date)
			}
			kit.Text(ctx, label, t.Text.Xs).Grow(1).TextColor(t.Muted).SingleLine()
		}
	})
	if len(data.Days) > 0 {
		first, last := data.Days[0], data.Days[len(data.Days)-1]
		kit.Text(ctx, "成本 "+formatTrajectoryCost(first.Cost)+" → "+formatTrajectoryCost(last.Cost), t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) insightsSessionsCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.insightsData(ctx)
	if data == nil {
		return
	}
	trajectoryCardHeader(ctx, iconChat, strconv.Itoa(len(data.Sessions))+" 个会话")
	if len(data.Sessions) == 0 {
		kit.Text(ctx, "近 "+strconv.Itoa(s.insightsDays())+" 天还没有会话用量。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	sessions := data.Sessions
	if len(sessions) > 4 {
		sessions = sessions[:4]
	}
	for _, session := range sessions {
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
		row.Children(func() {
			title := session.Title
			if title == "" {
				title = session.ConversationId
			}
			kit.Text(ctx, title, t.Text.Xs).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, insightRequestsLabel(session.Requests), t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, formatTrajectoryTokens(session.Tokens), t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, formatTrajectoryCost(session.Cost), t.Text.Xs).TextColor(t.Muted)
		})
	}
	if len(data.Sessions) > len(sessions) {
		kit.Text(ctx, "另有 "+strconv.Itoa(len(data.Sessions)-len(sessions))+" 个会话", t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) panelInsights(ctx *ui.Context) {
	s.scopeLineGlobal(ctx)
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.insights.data == nil && s.insights.failed == "" {
		s.ensureInsights()
		skeletonInsightsPage(ctx)
		return
	}
	data := s.insightsData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	trajectoryStatGrid(ctx, [][][2]string{
		{{"总 tokens", formatTrajectoryTokens(totals.Tokens)}, {"成本", formatTrajectoryCost(totals.Cost)}, {"请求", strconv.Itoa(totals.Requests)}},
		{{"缓存命中", formatTrajectoryPercent(totals.CacheHitRate)}, {"会话", strconv.Itoa(totals.Sessions)}, {"日均", formatTrajectoryCompactTokens(averageInsightTokens(data))}},
	})
	kit.Separator(ctx, false)
	peak := int64(0)
	for _, day := range data.Days {
		if day.Tokens > peak {
			peak = day.Tokens
		}
	}
	chartHeight := th.Space(6)
	chart := ui.Row(ctx).FillWidth().Height(chartHeight).Gap(th.Space(1)).AlignItems(ui.End).Clip()
	chart.Children(func() {
		for _, day := range data.Days {
			ratio := float32(0)
			if peak > 0 {
				ratio = float32(day.Tokens) / float32(peak)
			}
			ui.Box(ctx).Grow(1).Height(2 + ratio*(chartHeight-4)).Radius(t.Radius.Xs).
				Background(palette.Blue500.Color().Alpha(0.7))
		}
	})
	if len(data.Sessions) > 0 {
		kit.Separator(ctx, false)
		for index, session := range data.Sessions {
			if index >= 4 {
				break
			}
			title := session.Title
			if title == "" {
				title = session.ConversationId
			}
			row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
			row.Children(func() {
				kit.Text(ctx, title, t.Text.Xs).Grow(1).SingleLine().Ellipsis("…")
				kit.Text(ctx, strconv.Itoa(session.Requests)+" 次", t.Text.Xs).TextColor(t.Muted)
				kit.Text(ctx, formatTrajectoryTokens(session.Tokens), t.Text.Xs).TextColor(t.Muted)
				kit.Text(ctx, formatTrajectoryCost(session.Cost), t.Text.Xs).TextColor(t.Muted)
			})
		}
	}
}
