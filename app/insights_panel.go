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
	text := "正在汇总近 7 天…"
	if state.failed != "" {
		text = state.failed
	}
	kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
	if !state.loading && state.failed == "" {
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
		kit.Text(ctx, "近 7 天", t.Text.Xs).TextColor(t.Muted)
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
	labels.Children(func() {
		for _, day := range data.Days {
			kit.Text(ctx, formatInsightDate(day.Date), t.Text.Xs).Grow(1).TextColor(t.Muted)
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
		kit.Text(ctx, "近 7 天还没有会话用量。", t.Text.Sm).TextColor(t.Muted)
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
