package main

import (
	"fmt"
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

type trajectorySlice struct {
	Label   string
	Value   float64
	Display string
	Color   ui.Color
}

func (s *shellState) trajectoryData(ctx *ui.Context) *conversationTrajectory {
	t := gwtheme.Of(ctx)
	state := &s.trajectory
	if state.data != nil {
		return state.data
	}
	text := "正在整理轨迹…"
	if state.failed != "" {
		text = state.failed
	}
	kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
	if !state.loading && state.failed == "" {
		go s.ensureTrajectory()
	}
	return nil
}

func trajectoryCardHeader(ctx *ui.Context, icon *ui.SVG, meta string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
	row.Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
		ui.Spacer(ctx)
		if meta != "" {
			kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
	})
}

func trajectoryStatCell(ctx *ui.Context, label, value string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	cell := ui.Column(ctx).Grow(1).Padding(th.Space(1.5)).Gap(th.Space(0.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
	cell.Children(func() {
		kit.Text(ctx, value, t.Text.Lg).FontWeight(600).SingleLine().Ellipsis("…")
		kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	})
}

func trajectoryStatGrid(ctx *ui.Context, rows [][][2]string) {
	th := ctx.Theme()
	for _, row := range rows {
		group := row
		ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
			for _, cell := range group {
				trajectoryStatCell(ctx, cell[0], cell[1])
			}
		})
	}
}

func (s *shellState) trajectorySummaryCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
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
		kit.Separator(ctx, false)
		kit.Text(ctx, "工具调用", t.Text.Xs).TextColor(t.Muted)
		limit := len(totals.ToolsByName)
		if limit > 6 {
			limit = 6
		}
		for _, tool := range totals.ToolsByName[:limit] {
			row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
			row.Children(func() {
				kit.Text(ctx, tool.Name, t.Text.Xs).FontWeight(500).Grow(1).SingleLine().Ellipsis("…")
				kit.Text(ctx, strconv.Itoa(tool.Count)+" 次", t.Text.Xs).TextColor(t.Muted)
				kit.Text(ctx, formatTrajectoryDuration(tool.Ms), t.Text.Xs).TextColor(t.Muted)
				if tool.Errors > 0 {
					kit.Text(ctx, strconv.Itoa(tool.Errors)+" 失败", t.Text.Xs).TextColor(t.Danger)
				}
			})
		}
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
		{Label: "未缓存输入", Value: float64(totals.Input), Display: formatTrajectoryTokens(totals.Input) + " tokens", Color: palette.Blue500.Color()},
		{Label: "缓存读取", Value: float64(totals.CacheRead), Display: formatTrajectoryTokens(totals.CacheRead) + " tokens", Color: palette.Violet500.Color()},
		{Label: "缓存写入", Value: float64(totals.CacheWrite), Display: formatTrajectoryTokens(totals.CacheWrite) + " tokens", Color: palette.Amber500.Color()},
		{Label: "输出", Value: float64(totals.Output), Display: formatTrajectoryTokens(totals.Output) + " tokens", Color: palette.Green500.Color()},
	}
	trajectoryCardHeader(ctx, iconDatabase, "缓存命中 "+formatTrajectoryPercent(totals.CacheHitRate))
	if total <= 0 {
		kit.Text(ctx, "还没有 token 数据。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	trajectoryDonutLegend(ctx, slices, formatTrajectoryTokens(int64(total)), "总 tokens")
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
	trajectoryDonutLegend(ctx, slices, formatTrajectoryDuration(timing.WallMs), "活跃时长")
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
	big := ui.Row(ctx).FillWidth().AlignItems(ui.End).Gap(th.Space(1))
	big.Children(func() {
		kit.Text(ctx, formatTrajectoryTokens(context.LastTokens), t.Text.X2l).FontWeight(600)
		kit.Text(ctx, "tokens · 最近一次请求", t.Text.Xs).TextColor(t.Muted)
	})
	kit.Text(ctx, "峰值 "+formatTrajectoryTokens(context.PeakTokens)+" tokens · 累计 "+formatTrajectoryTokens(totals.TotalTokens)+" tokens",
		t.Text.Xs).TextColor(t.Muted)
	if context.PeakTokens > 0 {
		ratio := float32(context.LastTokens) / float32(context.PeakTokens)
		if ratio > 1 {
			ratio = 1
		}
		bar := ui.Row(ctx).FillWidth().Height(th.Space(1.5)).Radius(t.Radius.Full).Background(t.Hover)
		bar.Children(func() {
			ui.Box(ctx).Grow(ratio).FillHeight().Radius(t.Radius.Full).Background(palette.Blue500.Color())
			if ratio < 1 {
				ui.Box(ctx).Grow(1 - ratio).FillHeight()
			}
		})
	}
	kit.Separator(ctx, false)
	kit.Text(ctx, "最近回合的上下文占用", t.Text.Xs).TextColor(t.Muted)
	turns := data.Turns
	if len(turns) > 12 {
		turns = turns[len(turns)-12:]
	}
	if len(turns) == 0 {
		return
	}
	chart := ui.Row(ctx).FillWidth().Height(th.Space(10)).Gap(th.Space(1)).AlignItems(ui.End)
	chart.Children(func() {
		for _, turn := range turns {
			value := turn.Usage.ContextTokens
			if value <= 0 {
				value = turn.Usage.Total
			}
			height := float32(4)
			if context.PeakTokens > 0 {
				height = 4 + float32(value)/float32(context.PeakTokens)*float32(th.Space(8))
			}
			ui.Box(ctx).Grow(1).Height(height).Radius(t.Radius.Xs).Background(palette.Blue500.Color().Alpha(0.65))
		}
	})
}

func trajectoryDonutLegend(ctx *ui.Context, slices []trajectorySlice, centerTop, centerSub string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	total := 0.0
	for _, slice := range slices {
		if slice.Value > 0 {
			total += slice.Value
		}
	}
	row := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
	row.Children(func() {
		donut := ui.Box(ctx).Size(th.Space(26), th.Space(26))
		donut.Draw(func(p *ui.Painter, r ui.Rect) {
			cx, cy := r.X+r.W/2, r.Y+r.H/2
			outer, inner := r.W/2, r.W/2*0.62
			angle := float32(-math.Pi / 2)
			gap := float32(0.03)
			for _, slice := range slices {
				if slice.Value <= 0 {
					continue
				}
				sweep := float32(slice.Value/total) * 2 * float32(math.Pi)
				path := &ui.Path{}
				trajectoryWedge(path, cx, cy, outer, inner, angle+gap/2, angle+sweep-gap/2)
				p.FillPath(path, slice.Color)
				angle += sweep
			}
		})
		donut.Children(func() {
			ui.Column(ctx).Fill().Center().Children(func() {
				kit.Text(ctx, centerTop, t.Text.Lg).FontWeight(600).SingleLine()
				kit.Text(ctx, centerSub, t.Text.Xs).TextColor(t.Muted)
			})
		})
		legend := ui.Column(ctx).Grow(1).Gap(th.Space(1))
		legend.Children(func() {
			for _, slice := range slices {
				share := 0.0
				if total > 0 {
					share = slice.Value / total * 100
				}
				line := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
				line.Children(func() {
					ui.Box(ctx).Size(th.Space(2), th.Space(2)).Radius(t.Radius.Full).Background(slice.Color)
					kit.Text(ctx, slice.Label, t.Text.Xs).Grow(1).SingleLine().Ellipsis("…")
					kit.Text(ctx, slice.Display, t.Text.Xs).TextColor(t.Muted)
					kit.Text(ctx, strconv.FormatFloat(share, 'f', 1, 64)+"%", t.Text.Xs).TextColor(t.Muted)
				})
			}
		})
	})
}

func trajectoryWedge(path *ui.Path, cx, cy, outer, inner, start, end float32) {
	if end <= start {
		return
	}
	steps := int(math.Max(2, math.Ceil(float64((end-start)/0.10))))
	point := func(radius, angle float32) (float32, float32) {
		return cx + radius*float32(math.Cos(float64(angle))), cy + radius*float32(math.Sin(float64(angle)))
	}
	x, y := point(outer, start)
	path.MoveTo(x, y)
	for index := 1; index <= steps; index++ {
		x, y = point(outer, start+(end-start)*float32(index)/float32(steps))
		path.LineTo(x, y)
	}
	x, y = point(inner, end)
	path.LineTo(x, y)
	for index := steps - 1; index >= 0; index-- {
		x, y = point(inner, start+(end-start)*float32(index)/float32(steps))
		path.LineTo(x, y)
	}
	path.Close()
}
