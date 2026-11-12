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
	cell := ui.Column(ctx).Grow(1).Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
	cell.Children(func() {
		kit.Text(ctx, value, t.Text.Sm).FontWeight(600).SingleLine().Ellipsis("…")
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
		donut := ui.Box(ctx).Size(th.Space(22), th.Space(22))
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
				kit.Text(ctx, centerTop, t.Text.Sm).FontWeight(600).SingleLine().
					Width(th.Space(20)).Ellipsis("…")
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

func (s *shellState) trajectoryTrendCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	requests := data.Requests
	if len(requests) > 60 {
		requests = requests[len(requests)-60:]
	}
	trajectoryCardHeader(ctx, iconActivity, strconv.Itoa(len(data.Requests))+" 次请求 · 峰值 "+formatTrajectoryTokens(data.Totals.Context.PeakTokens))
	if len(requests) == 0 {
		kit.Text(ctx, "还没有请求趋势。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	peak := data.Totals.Context.PeakTokens
	if peak <= 0 {
		for _, request := range requests {
			if request.ContextTokens > peak {
				peak = request.ContextTokens
			}
		}
	}
	chart := ui.Row(ctx).FillWidth().Height(th.Space(9)).Gap(1).AlignItems(ui.End)
	chart.Children(func() {
		for _, request := range requests {
			height := float32(3)
			if peak > 0 {
				height = 3 + float32(request.ContextTokens)/float32(peak)*float32(th.Space(8))
			}
			ui.Box(ctx).Grow(1).Height(height).Radius(t.Radius.Xs).
				Background(palette.Blue500.Color().Alpha(0.7))
		}
	})
	kit.Text(ctx, "最近 "+strconv.Itoa(len(requests))+" 次请求 · 越靠右越新", t.Text.Xs).TextColor(t.Muted)
}

func trajectoryEventLabel(event trajectoryEvent) string {
	switch event.Type {
	case "session.compacted":
		return "上下文压缩"
	case "session.compaction_started":
		return "压缩开始"
	case "session.compaction_failed":
		return "压缩失败"
	case "session.compaction_skipped":
		return "压缩跳过"
	case "operation.usage_reconciled":
		return "用量校准"
	}
	return event.Type
}

func (s *shellState) trajectoryEventsCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	trajectoryCardHeader(ctx, iconClock, strconv.Itoa(len(data.Events))+" 个事件")
	if len(data.Events) == 0 {
		kit.Text(ctx, "还没有上下文事件。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	limit := len(data.Events)
	if limit > 4 {
		limit = 4
	}
	for _, event := range data.Events[:limit] {
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
		row.Children(func() {
			kit.Text(ctx, formatTrajectoryClock(event.At), t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, trajectoryEventLabel(event), t.Text.Xs).FontWeight(500).Grow(1).SingleLine().Ellipsis("…")
			if event.Tokens > 0 {
				kit.Text(ctx, formatTrajectoryTokens(event.Tokens)+" tokens", t.Text.Xs).TextColor(t.Muted)
			}
			if event.Text != "" {
				kit.Text(ctx, event.Text, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
	}
	if len(data.Events) > limit {
		kit.Text(ctx, "另有 "+strconv.Itoa(len(data.Events)-limit)+" 个事件", t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) trajectoryCommandsCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	total := 0
	for _, command := range data.Totals.Commands {
		total += command.Count
	}
	trajectoryCardHeader(ctx, iconDoc, strconv.Itoa(total)+" 次命令")
	if len(data.Totals.Commands) == 0 {
		kit.Text(ctx, "还没有命令记录。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	commands := data.Totals.Commands
	if len(commands) > 4 {
		commands = commands[:4]
	}
	for _, command := range commands {
		share := 0.0
		if total > 0 {
			share = float64(command.Count) / float64(total)
		}
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center)
		row.Children(func() {
			kit.Text(ctx, command.Name, t.Text.Xs).Grow(1).SingleLine().Ellipsis("…")
			bar := ui.Row(ctx).Width(th.Space(18)).Height(th.Space(1)).Radius(t.Radius.Full).Background(t.Hover)
			bar.Children(func() {
				ratio := float32(share)
				if ratio > 1 {
					ratio = 1
				}
				ui.Box(ctx).Grow(ratio).FillHeight().Radius(t.Radius.Full).Background(palette.Teal500.Color())
				if ratio < 1 {
					ui.Box(ctx).Grow(1 - ratio).FillHeight()
				}
			})
			kit.Text(ctx, strconv.Itoa(command.Count), t.Text.Xs).TextColor(t.Muted)
		})
	}
	if len(data.Totals.Commands) > len(commands) {
		kit.Text(ctx, "另有 "+strconv.Itoa(len(data.Totals.Commands)-len(commands))+" 个程序", t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) trajectoryFilesCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	files := data.Totals.Files
	total := files.Read + files.Write + files.Search + files.Image
	trajectoryCardHeader(ctx, iconFolder, strconv.Itoa(total)+" 次文件操作")
	rows := [][3]any{
		{"读取", files.Read, palette.Blue500.Color()},
		{"写入", files.Write, palette.Violet500.Color()},
		{"搜索", files.Search, palette.Teal500.Color()},
		{"图片", files.Image, palette.Amber500.Color()},
	}
	for _, entry := range rows {
		label := entry[0].(string)
		count := entry[1].(int)
		color := entry[2].(ui.Color)
		share := float32(0)
		if total > 0 {
			share = float32(count) / float32(total)
		}
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center)
		row.Children(func() {
			kit.Text(ctx, label, t.Text.Xs).Width(th.Space(8))
			bar := ui.Row(ctx).Grow(1).Height(th.Space(1)).Radius(t.Radius.Full).Background(t.Hover)
			bar.Children(func() {
				ui.Box(ctx).Grow(share).FillHeight().Radius(t.Radius.Full).Background(color)
				if share < 1 {
					ui.Box(ctx).Grow(1 - share).FillHeight()
				}
			})
			kit.Text(ctx, strconv.Itoa(count), t.Text.Xs).TextColor(t.Muted).Width(th.Space(8))
		})
	}
	if total > 0 {
		kit.Text(ctx, "共 "+strconv.Itoa(total)+" 次文件操作 · 读取 "+strconv.Itoa(files.Read)+" 次",
			t.Text.Xs).TextColor(t.Muted)
	}
}
