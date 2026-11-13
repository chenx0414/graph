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
	t, th := gwtheme.Of(ctx), ctx.Theme()
	data := s.trajectoryData(ctx)
	if data == nil {
		return
	}
	s.ensureModelMeta()
	parts := contextOverviewParts(contextOverviewComposition(data))
	total := contextPartsTotal(parts)
	model := s.contextOverviewModel()
	meta, known := s.modelMetaFor(model)
	window := int64(0)
	if known {
		window = meta.contextWindow
	}
	used := data.Totals.Context.LastTokens
	if used <= 0 {
		used = data.Totals.Context.PeakTokens
	}
	if used <= 0 {
		used = total
	}
	card := ui.Column(ctx).FillWidth().Padding(th.Space(3.5), th.Space(4), th.Space(3.5), th.Space(4)).
		Gap(th.Space(2)).Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Background(t.Card)
	card.Children(func() {
		title := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
		title.Children(func() {
			ui.Icon(ctx, iconGauge).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
			kit.Text(ctx, "当前上下文", t.Text.Base).FontWeight(600).SingleLine()
			ui.Spacer(ctx)
			if subtitle := s.contextOverviewSubtitle(model); subtitle != "" {
				kit.Text(ctx, subtitle, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
		numbers := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.End)
		numbers.Children(func() {
			kit.Text(ctx, formatTrajectoryCompactTokens(used), t.Text.X2l).FontWeight(600).SingleLine()
			if window > 0 {
				kit.Text(ctx, " / "+formatTrajectoryCompactTokens(window)+" tokens", t.Text.Sm).TextColor(t.Muted).SingleLine()
			} else {
				kit.Text(ctx, " tokens（估算）", t.Text.Sm).TextColor(t.Muted).SingleLine()
			}
			ui.Spacer(ctx)
			if window > 0 {
				kit.Text(ctx, strconv.FormatFloat(float64(used)/float64(window)*100, 'f', 1, 64)+"%", t.Text.X2l).
					FontWeight(600).SingleLine()
				kit.Text(ctx, " 上下文已用", t.Text.Xs).TextColor(t.Muted).SingleLine()
			}
		})
		s.contextOverviewBar(ctx, parts, total, used, window, meta.maxTokens)
		s.contextOverviewLegend(ctx, contextOverviewScaled(parts, used), used)
	})
}

func (s *shellState) contextOverviewBar(ctx *ui.Context, parts []contextPart, total, used, window, maxTokens int64) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bar := ui.Row(ctx).FillWidth().Height(th.Space(4)).Radius(t.Radius.Sm).Clip()
	if window <= 0 {
		window = used
	}
	if window <= 0 {
		window = 1
	}
	usedFraction := float32(used) / float32(window)
	if usedFraction > 1 {
		usedFraction = 1
	}
	if usedFraction < 0 {
		usedFraction = 0
	}
	headroom := float32(0)
	if window > 0 {
		headroom = float32(window*30/100) / float32(window)
	}
	output := float32(0)
	if maxTokens > 0 {
		output = float32(maxTokens) / float32(window)
	}
	available := 1 - usedFraction
	if headroom > available {
		headroom = available
	}
	if output > available-headroom {
		output = available - headroom
	}
	free := available - headroom - output
	bar.Children(func() {
		partsTotal := contextPartsTotal(parts)
		if partsTotal > 0 {
			for _, part := range parts {
				if part.tokens <= 0 {
					continue
				}
				weight := usedFraction * float32(part.tokens) / float32(partsTotal)
				ui.Box(ctx).Grow(weight).FillHeight().Background(part.color)
			}
			if extra := usedFraction * float32(used-partsTotal) / float32(used); extra > 0 {
				ui.Box(ctx).Grow(extra).FillHeight().Background(t.Muted)
			}
		}
		if headroom > 0 {
			contextHatch(ctx, headroom, palette.Amber500.Color(), 0.28)
		}
		if output > 0 {
			contextHatch(ctx, output, palette.Blue500.Color(), 0.28)
		}
		if free > 0 {
			ui.Box(ctx).Grow(free).FillHeight().Background(t.Hover)
		}
	})
}

func contextHatch(ctx *ui.Context, weight float32, color ui.Color, alpha float32) {
	box := ui.Box(ctx).Grow(weight).FillHeight().Background(gwtheme.Of(ctx).Hover)
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		p.Clip(r, 0, func() {
			step := float32(8)
			for x := r.X - r.H; x < r.X+r.W; x += step {
				p.StrokePolyline([][2]float32{{x, r.Y + r.H}, {x + r.H, r.Y}}, 2.4, color.Alpha(alpha))
			}
		})
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
