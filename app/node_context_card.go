package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// nodeContextCardView is the truth-only, scope-independent view of one
// Agent(node)'s context. It is deliberately built from an explicit trajectory
// and model/window inputs so a node session can render its own card without
// ever borrowing the main conversation's active chat state.
type nodeContextCardView struct {
	used      int64
	window    int64
	model     string
	agentName string
	parts     []contextPart
}

// buildNodeContextCardData derives the card from a node's own trajectory. The
// occupancy is the measured LastTokens, never PeakTokens or an estimate; the
// composition is the latest request snapshot scaled onto that occupancy so
// the legend adds up to the number the card reports. Peak-only changes and the
// main session's model never enter this view, which keeps the card stable
// across redraws and scrolls.
func buildNodeContextCardData(data *conversationTrajectory, model, agentName string, window int64) nodeContextCardView {
	view := nodeContextCardView{model: model, agentName: agentName, window: window}
	if data == nil {
		return view
	}
	view.used = data.Totals.Context.LastTokens
	if view.used < 0 {
		view.used = 0
	}
	view.parts = contextOverviewDisplayParts(data, view.used)
	return view
}

// nodeContextCardSubtitle is the small meta line under the card title. It
// shows which agent the card belongs to and the model it actually used.
func nodeContextCardSubtitle(view nodeContextCardView) string {
	name := shortModel(view.model)
	if view.agentName != "" {
		if name == "" {
			return view.agentName
		}
		return view.agentName + " · " + name
	}
	return name
}

// renderNodeContextCard paints a single Agent(node) context card. It mirrors
// the main "当前上下文" card: real occupancy, model window, a single proportional
// bar and a composition legend. With no measured occupancy it shows an empty
// state and invents nothing.
func renderNodeContextCard(ctx *ui.Context, view nodeContextCardView) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).FillWidth().PaddingEnd(th.Space(3)).Gap(th.Space(1.5)).Label("节点上下文")
	card.Children(func() {
		title := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
		title.Children(func() {
			ui.Icon(ctx, iconGauge).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
			kit.Text(ctx, "当前上下文", t.Text.Base).FontWeight(600).SingleLine()
			subtitleRow := ui.Row(ctx).Grow(1).AlignItems(ui.Center)
			subtitleRow.Children(func() {
				ui.Spacer(ctx)
				if subtitle := nodeContextCardSubtitle(view); subtitle != "" {
					kit.Text(ctx, subtitle, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
				}
			})
		})
		if view.used <= 0 {
			kit.Text(ctx, "暂无真实上下文数据", t.Text.Sm).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, "模型回报真实占用后这里会显示组成。", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			return
		}
		numbers := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.End)
		numbers.Children(func() {
			left := ui.Row(ctx).Grow(1).Gap(th.Space(1.5)).AlignItems(ui.End)
			left.Children(func() {
				kit.Text(ctx, formatTrajectoryCompactTokens(view.used), t.Text.X2l).FontWeight(600).SingleLine()
				if view.window > 0 {
					kit.Text(ctx, " / "+formatTrajectoryCompactTokens(view.window)+" tokens", t.Text.Sm).TextColor(t.Muted).
						SingleLine().Ellipsis("…")
				} else {
					kit.Text(ctx, " tokens（估算）", t.Text.Sm).TextColor(t.Muted).SingleLine().Ellipsis("…")
				}
			})
			if view.window > 0 {
				right := ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.End)
				right.Children(func() {
					kit.Text(ctx, strconv.FormatFloat(float64(view.used)/float64(view.window)*100, 'f', 1, 64)+"%", t.Text.X2l).
						FontWeight(600).SingleLine()
					kit.Text(ctx, " 上下文已用", t.Text.Xs).TextColor(t.Muted).SingleLine()
				})
			}
		})
		nodeContextBar(ctx, contextOverviewBarSegments(view.parts, view.used, view.window))
		nodeContextLegend(ctx, view.parts, view.used)
	})
}

// nodeContextBar paints all composition segments on one thin row that spans
// the window exactly once. The label makes the painted bar addressable in the
// UI tester so a test can verify the segments really sit side by side.
func nodeContextBar(ctx *ui.Context, segments []contextBarSegment) {
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

func nodeContextLegend(ctx *ui.Context, parts []contextPart, total int64) {
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

// nodeAgentName resolves the human label for the active node session from the
// chat title or the node's own trajectory, without consulting the main chat.
func (s *shellState) nodeAgentName() string {
	chat := s.active()
	if chat != nil && chat.agentTitle != "" {
		return chat.agentTitle
	}
	data := s.trajectory.data
	if data == nil {
		return ""
	}
	for index := len(data.Agents) - 1; index >= 0; index-- {
		agent := data.Agents[index]
		if agent.Role != "" {
			return agent.Role
		}
		if agent.NodeId != "" {
			return agent.NodeId
		}
	}
	return ""
}

// nodeContextCard renders the current node session's own context card. It is
// the integration entry point: it returns false when the active chat is not a
// node scope or has no trajectory yet, so the caller can decide whether to
// reserve space. Data is loaded through the existing scope-aware trajectory
// loader, whose endpoint already handles /api/tasks/{task}/nodes/{node}/trajectory.
func (s *shellState) nodeContextCard(ctx *ui.Context) bool {
	scope := s.chatScope()
	if scope.Kind != "node" {
		return false
	}
	state := &s.trajectory
	if state.data == nil || state.scopeKey != scope.key() {
		if !state.loading() {
			go s.ensureTrajectory()
		}
		return false
	}
	s.ensureModelMeta()
	model := s.contextOverviewModel()
	window := int64(0)
	if meta, known := s.modelMetaFor(model); known {
		window = meta.contextWindow
	}
	view := buildNodeContextCardData(state.data, model, s.nodeAgentName(), window)
	renderNodeContextCard(ctx, view)
	return true
}
