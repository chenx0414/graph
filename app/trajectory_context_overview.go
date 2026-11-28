package main

import (
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

type contextPart struct {
	key    string
	label  string
	color  ui.Color
	tokens int64
}

var contextPartSpecs = []struct {
	key   string
	label string
	color ui.Color
}{
	{"system", "系统提示词", palette.Indigo500.Color()},
	{"tools", "工具定义", palette.Amber500.Color()},
	{"user", "用户消息", palette.Green500.Color()},
	{"inject", "注入内容", palette.Purple500.Color()},
	{"assistant", "助手消息", palette.Blue500.Color()},
	{"tool", "工具结果", palette.Teal500.Color()},
}

func contextOverviewParts(composition trajectoryComposition) []contextPart {
	values := map[string]int64{
		"system":    composition.SystemPrompt,
		"tools":     composition.ToolDefinitions,
		"user":      composition.UserMessages,
		"inject":    composition.Injected,
		"assistant": composition.AssistantReply,
		"tool":      composition.ToolCalls,
	}
	parts := make([]contextPart, 0, len(contextPartSpecs))
	for _, spec := range contextPartSpecs {
		parts = append(parts, contextPart{key: spec.key, label: spec.label, color: spec.color, tokens: values[spec.key]})
	}
	return parts
}

// contextOverviewDisplayParts returns the composition the card shows: the parts
// of the latest request snapshot when the trajectory carries requests, scaled
// onto the measured occupancy so the legend adds up to the same total the card
// reports. A trajectory without request snapshots keeps its raw estimated
// composition, so the card never invents an occupancy split it cannot measure.
func contextOverviewDisplayParts(data *conversationTrajectory, used int64) []contextPart {
	parts := contextOverviewParts(contextOverviewComposition(data))
	if len(data.Requests) == 0 || used <= 0 {
		return parts
	}
	return contextOverviewScaled(parts, used)
}

func contextPartsTotal(parts []contextPart) int64 {
	total := int64(0)
	for _, part := range parts {
		total += part.tokens
	}
	return total
}

func contextOverviewComposition(data *conversationTrajectory) trajectoryComposition {
	for index := len(data.Requests) - 1; index >= 0; index-- {
		if data.Requests[index].Composition != nil {
			return *data.Requests[index].Composition
		}
	}
	return data.Composition
}

func contextOverviewScaled(parts []contextPart, used int64) []contextPart {
	total := contextPartsTotal(parts)
	if total <= 0 || used <= 0 || used == total {
		return parts
	}
	scaled := make([]contextPart, len(parts))
	assigned := int64(0)
	largest, largestShare := 0, int64(-1)
	for index, part := range parts {
		value := int64(0)
		if part.tokens > 0 {
			value = used * part.tokens / total
		}
		scaled[index] = part
		scaled[index].tokens = value
		assigned += value
		if part.tokens > largestShare {
			largest, largestShare = index, part.tokens
		}
	}
	if remainder := used - assigned; remainder != 0 && largestShare > 0 {
		scaled[largest].tokens += remainder
		if scaled[largest].tokens < 0 {
			scaled[largest].tokens = 0
		}
	}
	return scaled
}

func contextOverviewPercent(tokens, total int64) int {
	if total <= 0 || tokens <= 0 {
		return 0
	}
	return int(math.Round(float64(tokens) / float64(total) * 100))
}

func (s *shellState) contextOverviewModel() string {
	if chat := s.active(); chat != nil && chat.currentModel != "" {
		return chat.currentModel
	}
	data := s.trajectory.data
	if data == nil {
		return ""
	}
	for index := len(data.Agents) - 1; index >= 0; index-- {
		if data.Agents[index].Model != "" {
			return data.Agents[index].Model
		}
	}
	for index := len(data.Requests) - 1; index >= 0; index-- {
		if data.Requests[index].Model != "" {
			return data.Requests[index].Model
		}
	}
	return ""
}

func (s *shellState) contextOverviewSubtitle(model string) string {
	label := ""
	if agent, _ := s.chatAgent(); agent != nil && agent.Name != "" {
		label = agent.Name
	}
	name := shortModel(model)
	if name == "" {
		return label
	}
	if thinking := s.active().currentThinking; thinking != "" {
		name += " (" + thinking + ")"
	}
	if label == "" {
		return name
	}
	return label + " · " + name
}

func (s *shellState) panelContextOverview(ctx *ui.Context) {
	// A node Agent session shows its own context, never the main
	// conversation's: route the panel to the node card.
	if s.chatScope().Kind == "node" {
		s.panelNodeContext(ctx)
		return
	}
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	s.ensureModelMeta()
	s.ensurePromptRecord()
	used := data.Totals.Context.LastTokens
	parts := contextOverviewDisplayParts(data, used)
	model := s.contextOverviewModel()
	meta, known := s.modelMetaFor(model)
	window := int64(0)
	if known {
		window = meta.contextWindow
	}
	card := ui.Column(ctx).FillWidth().Gap(th.Space(1.5))
	card.Children(func() {
		title := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
		title.Children(func() {
			ui.Icon(ctx, iconGauge).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
			kit.Text(ctx, "当前上下文", t.Text.Base).FontWeight(600).SingleLine()
			subtitleRow := ui.Row(ctx).Grow(1).AlignItems(ui.Center)
			subtitleRow.Children(func() {
				ui.Spacer(ctx)
				if subtitle := s.contextOverviewSubtitle(model); subtitle != "" {
					kit.Text(ctx, subtitle, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
				}
			})
		})
		s.contextTabRow(ctx)
		if s.contextTab != contextTabContext {
			s.contextPromptBody(ctx)
			return
		}
		if used <= 0 {
			kit.Text(ctx, "暂无真实上下文数据", t.Text.Sm).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, "模型回报真实占用后这里会显示组成。", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			return
		}
		numbers := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.End)
		numbers.Children(func() {
			left := ui.Row(ctx).Grow(1).Gap(th.Space(1.5)).AlignItems(ui.End)
			left.Children(func() {
				kit.Text(ctx, formatTrajectoryCompactTokens(used), t.Text.X2l).FontWeight(600).SingleLine()
				if window > 0 {
					kit.Text(ctx, " / "+formatTrajectoryCompactTokens(window)+" tokens", t.Text.Sm).TextColor(t.Muted).
						SingleLine().Ellipsis("…")
				} else {
					kit.Text(ctx, " tokens（估算）", t.Text.Sm).TextColor(t.Muted).SingleLine().Ellipsis("…")
				}
			})
			if window > 0 {
				right := ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.End)
				right.Children(func() {
					kit.Text(ctx, strconv.FormatFloat(float64(used)/float64(window)*100, 'f', 1, 64)+"%", t.Text.X2l).
						FontWeight(600).SingleLine()
					kit.Text(ctx, " 上下文已用", t.Text.Xs).TextColor(t.Muted).SingleLine()
				})
			}
		})
		s.contextOverviewBar(ctx, contextOverviewBarSegments(parts, used, window))
		s.contextOverviewLegend(ctx, parts, used)
	})
}

type contextBarSegment struct {
	kind   string
	weight float32
	color  ui.Color
}

func contextOverviewBarSegments(parts []contextPart, used, window int64) []contextBarSegment {
	if window <= 0 {
		window = used
	}
	if window <= 0 {
		window = 1
	}
	if used < 0 {
		used = 0
	}
	if used > window {
		used = window
	}
	if partsTotal := contextPartsTotal(parts); partsTotal > used {
		parts = contextOverviewScaled(parts, used)
	}
	segments := []contextBarSegment{}
	assigned := int64(0)
	for _, part := range parts {
		if part.tokens <= 0 {
			continue
		}
		assigned += part.tokens
		segments = append(segments, contextBarSegment{kind: "part", weight: float32(part.tokens) / float32(window), color: part.color})
	}
	if used > assigned {
		segments = append(segments, contextBarSegment{kind: "unaccounted", weight: float32(used-assigned) / float32(window)})
	}
	if free := float32(window-used) / float32(window); free > 0 {
		segments = append(segments, contextBarSegment{kind: "free", weight: free})
	}
	return segments
}

// contextOverviewBar paints the segments of one request's context as a single
// bar: every segment grows by its share of the whole window, so the bar spans
// the window exactly once instead of stacking one full width band per segment.
func (s *shellState) contextOverviewBar(ctx *ui.Context, segments []contextBarSegment) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Row(ctx).FillWidth().Height(th.Space(4)).Radius(t.Radius.Sm).Clip().Label("上下文组成")
	bar.Children(func() {
		for _, segment := range segments {
			if segment.weight <= 0 {
				continue
			}
			switch segment.kind {
			case "free":
				ui.Box(ctx).Grow(segment.weight).FillHeight().Background(t.Hover)
			case "unaccounted":
				ui.Box(ctx).Grow(segment.weight).FillHeight().Background(t.Muted)
			default:
				ui.Box(ctx).Grow(segment.weight).FillHeight().Background(segment.color)
			}
		}
	})
}

func (s *shellState) contextOverviewLegend(ctx *ui.Context, parts []contextPart, total int64) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	grid := ui.Column(ctx).FillWidth().Gap(th.Space(1.5))
	grid.Children(func() {
		for start := 0; start < len(parts); start += 3 {
			row := ui.Row(ctx).FillWidth().Gap(th.Space(3.5))
			row.Children(func() {
				for index := start; index < start+3 && index < len(parts); index++ {
					part := parts[index]
					chip := ui.Row(ctx).Grow(1).AlignItems(ui.Center).Gap(th.Space(1.25)).Padding(0, th.Space(1.5))
					chip.Children(func() {
						ui.Box(ctx).Size(th.Space(2), th.Space(2)).Radius(t.Radius.Xs).Background(part.color)
						kit.Text(ctx, part.label, t.Text.Sm).FontWeight(600).Grow(1).SingleLine().Ellipsis("…")
						kit.Text(ctx, "≈"+formatTrajectoryCompactTokens(part.tokens), t.Text.Xs).TextColor(t.Muted).SingleLine()
						kit.Text(ctx, strconv.Itoa(contextOverviewPercent(part.tokens, total))+"%", t.Text.Xs).
							TextColor(t.Muted).SingleLine()
					})
				}
			})
		}
	})
}
