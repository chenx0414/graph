package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const boardLongFlowMinWidth = float32(240)

const boardDefaultMinWidth = float32(280)

func measuredWidth(ctx *ui.Context, text string, size float32, weight int) float32 {
	if text == "" {
		return 0
	}
	width, _ := ctx.MeasureText(0, ui.Span{Text: text, Size: size, Weight: weight})
	return width
}

func (s *shellState) contextOverviewMinWidth(ctx *ui.Context) float32 {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	widest := float32(0)
	parts := contextOverviewParts(trajectoryComposition{})
	for start := 0; start < len(parts); start += 3 {
		row := float32(0)
		columns := 0
		for index := start; index < start+3 && index < len(parts); index++ {
			part := parts[index]
			chip := th.Space(2) + th.Space(1.25)
			chip += measuredWidth(ctx, part.label, t.Text.Sm, 600)
			chip += th.Space(1.25) + measuredWidth(ctx, "≈999.9M", t.Text.Xs, 400)
			chip += th.Space(1.25) + measuredWidth(ctx, "100%", t.Text.Xs, 400)
			chip += th.Space(1.5) * 2
			row += chip
			columns++
		}
		if columns > 1 {
			row += th.Space(3.5) * float32(columns-1)
		}
		widest = max(widest, row)
	}
	numbers := measuredWidth(ctx, "620.7k", t.Text.X2l, 600) +
		measuredWidth(ctx, " / 1.0M tokens", t.Text.Sm, 400) +
		th.Space(3) + measuredWidth(ctx, "100.0%", t.Text.X2l, 600) +
		measuredWidth(ctx, " 上下文已用", t.Text.Xs, 400)
	widest = max(widest, numbers)
	tabs := measuredWidth(ctx, "上下文", t.Text.Sm, 400) +
		measuredWidth(ctx, "System Prompt", t.Text.Sm, 400) +
		measuredWidth(ctx, "工具声明", t.Text.Sm, 400) +
		th.Space(2)*6
	widest = max(widest, tabs)
	return widest + th.Space(3)*2 + th.Space(3)
}

func (s *shellState) boardPanelMinWidth(ctx *ui.Context, panel *boardPanel) float32 {
	switch panel.Kind {
	case "context-overview":
		return s.contextOverviewMinWidth(ctx)
	case "fleet-collaboration", "fleet-events", "fleet-artifacts", "fleet-network",
		"agent-network", "trajectory", "history", "trajectory-trend", "trajectory-events",
		"trajectory-commands", "trajectory-files", "trajectory-requests", "trajectory-request-detail",
		"trajectory-agents", "fleet-history-list":
		return boardLongFlowMinWidth
	}
	return boardDefaultMinWidth
}

func (s *shellState) boardNodeMinWidth(ctx *ui.Context, node *boardNode) float32 {
	switch node.Kind {
	case "panel":
		panel := s.panelByID(node.PanelID)
		if panel == nil {
			return boardDefaultMinWidth
		}
		return s.boardPanelMinWidth(ctx, panel)
	case "split":
		if node.Axis == "row" {
			total := float32(0)
			for index := range node.Children {
				total += s.boardNodeMinWidth(ctx, &node.Children[index].Node)
			}
			return total
		}
		widest := float32(0)
		for index := range node.Children {
			widest = max(widest, s.boardNodeMinWidth(ctx, &node.Children[index].Node))
		}
		return widest
	}
	return boardDefaultMinWidth
}

func (s *shellState) boardPageMinWidth(ctx *ui.Context) float32 {
	return s.boardNodeMinWidth(ctx, &s.boardPage().Layout)
}

func boardCardChrome(ctx *ui.Context) float32 {
	th := ctx.Theme()
	return th.Space(3) * 2
}

func (s *shellState) boardPanelMinWidthWithChrome(ctx *ui.Context, panel *boardPanel) float32 {
	return s.boardPanelMinWidth(ctx, panel) + boardCardChrome(ctx)
}
