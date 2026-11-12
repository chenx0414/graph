package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

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

func (s *shellState) trajectoryCompositionCard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	composition := data.Composition
	values := []struct {
		label string
		value int64
		color ui.Color
	}{
		{"系统提示词", composition.SystemPrompt, palette.Blue500.Color()},
		{"工具定义", composition.ToolDefinitions, palette.Violet500.Color()},
		{"用户消息", composition.UserMessages, palette.Green500.Color()},
		{"助手回复", composition.AssistantReply, palette.Teal500.Color()},
		{"工具调用", composition.ToolCalls, palette.Amber500.Color()},
		{"注入内容", composition.Injected, palette.Pink500.Color()},
	}
	slices := []trajectorySlice{}
	total := int64(0)
	for _, entry := range values {
		if entry.value <= 0 {
			continue
		}
		slices = append(slices, trajectorySlice{Label: entry.label, Value: float64(entry.value),
			Display: formatTrajectoryTokens(entry.value), Color: entry.color})
		total += entry.value
	}
	trajectoryCardHeader(ctx, iconDatabase, "按字符估算")
	if total == 0 {
		kit.Text(ctx, "还没有组成数据。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	trajectoryDonutLegend(ctx, slices, formatTrajectoryCompactTokens(total), "估算 tokens")
}

func (s *shellState) trajectoryRequestsCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	requests := data.Requests
	if len(requests) > 8 {
		requests = requests[len(requests)-8:]
	}
	trajectoryCardHeader(ctx, iconClock, strconv.Itoa(len(data.Requests))+" 次请求")
	if len(requests) == 0 {
		kit.Text(ctx, "还没有请求记录。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	peak := data.Totals.Context.PeakTokens
	for _, request := range requests {
		ratio := float32(0)
		if peak > 0 {
			ratio = float32(request.ContextTokens) / float32(peak)
		}
		if ratio > 1 {
			ratio = 1
		}
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
		row.Children(func() {
			kit.Text(ctx, formatTrajectoryClock(request.At), t.Text.Xs).TextColor(t.Muted).Width(th.Space(11))
			bar := ui.Row(ctx).Grow(1).Height(th.Space(1.5)).Radius(t.Radius.Full).Background(t.Hover)
			bar.Children(func() {
				if composition := request.Composition; composition != nil {
					for _, segment := range trajectoryCompositionSegments(*composition) {
						ui.Box(ctx).Grow(segment.share).FillHeight().Background(segment.color)
					}
					return
				}
				ui.Box(ctx).Grow(ratio).FillHeight().Radius(t.Radius.Full).Background(palette.Blue500.Color())
				if ratio < 1 {
					ui.Box(ctx).Grow(1 - ratio).FillHeight()
				}
			})
			kit.Text(ctx, formatTrajectoryTokens(request.ContextTokens), t.Text.Xs).TextColor(t.Muted).Width(th.Space(8))
			kit.Text(ctx, formatTrajectoryTokens(request.Output)+" out", t.Text.Xs).TextColor(t.Muted).Width(th.Space(9))
		})
	}
}

func (s *shellState) trajectoryAgentsCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	agents := data.Agents
	if len(agents) > 6 {
		agents = agents[:6]
	}
	trajectoryCardHeader(ctx, iconShare, strconv.Itoa(len(data.Agents))+" 个 Agent")
	if len(agents) == 0 {
		kit.Text(ctx, "还没有 Agent 归属数据。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	for _, agent := range agents {
		name := agent.Role
		if name == "" {
			name = agent.NodeId
		}
		row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
		row.Children(func() {
			kit.Text(ctx, name, t.Text.Xs).FontWeight(500).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, strconv.Itoa(agent.Requests)+" 次", t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, formatTrajectoryTokens(agent.Tokens), t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, formatTrajectoryCost(agent.Cost), t.Text.Xs).TextColor(t.Muted)
		})
	}
}

type trajectoryCompositionSegment struct {
	share float32
	color ui.Color
}

func trajectoryCompositionSegments(composition trajectoryComposition) []trajectoryCompositionSegment {
	values := []struct {
		value int64
		color ui.Color
	}{
		{composition.SystemPrompt, palette.Blue500.Color()},
		{composition.ToolDefinitions, palette.Violet500.Color()},
		{composition.UserMessages, palette.Green500.Color()},
		{composition.AssistantReply, palette.Teal500.Color()},
		{composition.ToolCalls, palette.Amber500.Color()},
		{composition.Injected, palette.Pink500.Color()},
	}
	total := int64(0)
	for _, entry := range values {
		total += entry.value
	}
	if total <= 0 {
		return nil
	}
	segments := make([]trajectoryCompositionSegment, 0, len(values))
	for _, entry := range values {
		if entry.value <= 0 {
			continue
		}
		segments = append(segments, trajectoryCompositionSegment{share: float32(entry.value) / float32(total), color: entry.color})
	}
	return segments
}
