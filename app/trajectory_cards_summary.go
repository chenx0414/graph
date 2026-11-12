package main

import (
	"fmt"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) trajectorySummaryCard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	trajectoryCardHeader(ctx, iconActivity, strconv.Itoa(totals.Turns)+" 轮")
	trajectoryStatGrid(ctx, [][][2]string{
		{{"轮次", strconv.Itoa(totals.Turns)}, {"步数", strconv.Itoa(totals.Requests)}, {"模型回复", strconv.Itoa(totals.ModelReplies)}},
		{{"工具调用", strconv.Itoa(totals.ToolCalls)}, {"工具失败", strconv.Itoa(totals.ToolErrors)}, {"缓存命中", formatTrajectoryPercent(totals.CacheHitRate)}},
	})
	kit.Separator(ctx, false)
	kit.Text(ctx, fmt.Sprintf("用户消息 %d · 助手消息 %d · 工具消息 %d · 压缩 %d",
		totals.UserMessages, totals.ModelReplies, totals.ToolMessages, totals.Compactions), t.Text.Xs).TextColor(t.Muted)
	if len(totals.ToolsByName) > 0 {
		limit := len(totals.ToolsByName)
		if limit > 3 {
			limit = 3
		}
		line := "工具 "
		for index, tool := range totals.ToolsByName[:limit] {
			if index > 0 {
				line += " · "
			}
			line += tool.Name + " " + strconv.Itoa(tool.Count)
			if tool.Errors > 0 {
				line += "/" + strconv.Itoa(tool.Errors) + " 失败"
			}
		}
		if len(totals.ToolsByName) > limit {
			line += " · 另有 " + strconv.Itoa(len(totals.ToolsByName)-limit) + " 种"
		}
		kit.Text(ctx, line, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	}
}

func (s *shellState) trajectoryTokensCard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	total := float64(totals.Input + totals.CacheRead + totals.CacheWrite + totals.Output)
	slices := []trajectorySlice{
		{Label: "未缓存输入", Value: float64(totals.Input), Display: formatTrajectoryTokens(totals.Input), Color: palette.Blue500.Color()},
		{Label: "缓存读取", Value: float64(totals.CacheRead), Display: formatTrajectoryTokens(totals.CacheRead), Color: palette.Violet500.Color()},
		{Label: "缓存写入", Value: float64(totals.CacheWrite), Display: formatTrajectoryTokens(totals.CacheWrite), Color: palette.Amber500.Color()},
		{Label: "输出", Value: float64(totals.Output), Display: formatTrajectoryTokens(totals.Output), Color: palette.Green500.Color()},
	}
	trajectoryCardHeader(ctx, iconDatabase, "缓存命中 "+formatTrajectoryPercent(totals.CacheHitRate))
	if total <= 0 {
		kit.Text(ctx, "还没有 token 数据。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	trajectoryDonutLegend(ctx, slices, formatTrajectoryCompactTokens(int64(total)), "总 tokens")
	kit.Text(ctx, "成本 "+formatTrajectoryCost(totals.Cost)+" · 缓存读取占 "+formatTrajectoryPercent(totals.CacheHitRate),
		t.Text.Xs).TextColor(t.Muted)
}

func (s *shellState) trajectoryTimingCard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	timing := totals.Timing
	active := float64(timing.TtftMs + timing.GenMs + timing.ToolMs + timing.OtherMs)
	slices := []trajectorySlice{
		{Label: "首 token 等待", Value: float64(timing.TtftMs), Display: formatTrajectoryDuration(timing.TtftMs), Color: palette.Blue500.Color()},
		{Label: "模型生成", Value: float64(timing.GenMs), Display: formatTrajectoryDuration(timing.GenMs), Color: palette.Violet500.Color()},
		{Label: "工具执行", Value: float64(timing.ToolMs), Display: formatTrajectoryDuration(timing.ToolMs), Color: palette.Teal500.Color()},
		{Label: "其它开销", Value: float64(timing.OtherMs), Display: formatTrajectoryDuration(timing.OtherMs), Color: palette.Amber500.Color()},
	}
	meta := "实际用时 " + formatTrajectoryDuration(timing.WallMs)
	if timing.GenMs > 0 && totals.Output > 0 {
		meta += " · " + strconv.FormatFloat(float64(totals.Output)/(float64(timing.GenMs)/1000), 'f', 1, 64) + " tok/s"
	}
	trajectoryCardHeader(ctx, iconClock, meta)
	if active <= 0 {
		kit.Text(ctx, "还没有耗时数据。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	trajectoryDonutLegend(ctx, slices, formatTrajectoryCompactDuration(timing.WallMs), "活跃时长")
	kit.Text(ctx, strconv.Itoa(totals.Requests)+" 次模型请求 · "+strconv.Itoa(totals.ToolCalls)+" 次工具调用",
		t.Text.Xs).TextColor(t.Muted)
}

func (s *shellState) trajectoryContextCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	totals := data.Totals
	context := totals.Context
	trajectoryCardHeader(ctx, iconDoc, strconv.Itoa(totals.Requests)+" 次请求")
	value := ui.Row(ctx).FillWidth().AlignItems(ui.End).Gap(th.Space(1))
	value.Children(func() {
		kit.Text(ctx, formatTrajectoryTokens(context.LastTokens), t.Text.X2l).FontWeight(600).SingleLine().Ellipsis("…")
		kit.Text(ctx, "tokens", t.Text.Xs).TextColor(t.Muted)
	})
	kit.Text(ctx, "最近一次请求 · 峰值 "+formatTrajectoryTokens(context.PeakTokens)+" · 累计 "+formatTrajectoryCompactTokens(totals.TotalTokens),
		t.Text.Xs).TextColor(t.Muted)
	if context.PeakTokens > 0 {
		ratio := float32(context.LastTokens) / float32(context.PeakTokens)
		if ratio > 1 {
			ratio = 1
		}
		bar := ui.Row(ctx).FillWidth().Height(th.Space(1.5)).Radius(t.Radius.Full).Background(t.Hover).Clip()
		bar.Children(func() {
			ui.Box(ctx).Grow(ratio).FillHeight().Radius(t.Radius.Full).Background(palette.Blue500.Color())
			if ratio < 1 {
				ui.Box(ctx).Grow(1 - ratio).FillHeight()
			}
		})
	}
	kit.Separator(ctx, false)
	recent := []trajectoryTurn{}
	for _, turn := range data.Turns {
		if turn.Usage.ContextTokens > 0 {
			recent = append(recent, turn)
		}
	}
	if len(recent) == 0 {
		kit.Text(ctx, "还没有可用的上下文快照。", t.Text.Xs).TextColor(t.Muted)
		return
	}
	if len(recent) > 12 {
		recent = recent[len(recent)-12:]
	}
	kit.Text(ctx, "最近 "+strconv.Itoa(len(recent))+" 轮上下文占用", t.Text.Xs).TextColor(t.Muted)
	chartHeight := th.Space(6)
	chart := ui.Row(ctx).FillWidth().Height(chartHeight).Gap(th.Space(1)).AlignItems(ui.End).Clip()
	chart.Children(func() {
		for _, turn := range recent {
			ratio := float32(turn.Usage.ContextTokens) / float32(context.PeakTokens)
			if ratio > 1 {
				ratio = 1
			}
			height := float32(2) + ratio*(chartHeight-4)
			ui.Box(ctx).Grow(1).Height(height).Radius(t.Radius.Xs).Background(palette.Blue500.Color().Alpha(0.65))
		}
	})
}
