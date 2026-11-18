package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
)

const (
	boardPagePadding  = float32(10)
	boardDividerGap   = float32(8)
	boardMinColHeight = float32(240)
)

func boardPanelMinHeight(kind string) float32 {
	switch kind {
	case "fleet-kpi":
		return 120
	case "fleet-collaboration":
		return 440
	case "agent-network", "fleet-network", "graph-dag":
		return 420
	case "fleet-tasks":
		return 380
	case "fleet-events", "fleet-artifacts":
		return 320
	case "context-overview":
		return 300
	case "agent", "trajectory":
		return 420
	}
	return boardMinColHeight
}

func (s *shellState) boardNodeMinHeight(node *boardNode) float32 {
	switch node.Kind {
	case "panel":
		if panel := s.panelByID(node.PanelID); panel != nil {
			return boardPanelMinHeight(panel.Kind)
		}
		return boardPanelMinHeight(node.PanelID)
	case "split":
		if len(node.Children) == 0 {
			return 0
		}
		if node.Axis == "row" {
			tallest := float32(0)
			for index := range node.Children {
				tallest = max(tallest, s.boardNodeMinHeight(&node.Children[index].Node))
			}
			return tallest
		}
		total := float32(0)
		for index := range node.Children {
			total += s.boardNodeMinHeight(&node.Children[index].Node)
		}
		return total + float32(len(node.Children)-1)*boardDividerGap
	}
	return 0
}

func boardSizedColumn(weights, minimums []float32, available float32) []float32 {
	heights := make([]float32, len(weights))
	clamped := make([]bool, len(weights))
	remaining, free := available, len(weights)
	freeWeight := float32(0)
	for _, weight := range weights {
		freeWeight += weight
	}
	for pass := 0; pass <= len(weights) && free > 0 && freeWeight > 0; pass++ {
		changed := false
		scale := remaining / freeWeight
		for index := range weights {
			if clamped[index] {
				continue
			}
			heights[index] = weights[index] * scale
			if heights[index] < minimums[index] {
				heights[index] = minimums[index]
				clamped[index] = true
				free--
				freeWeight -= weights[index]
				remaining -= minimums[index]
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return heights
}

func (s *shellState) boardColumnPageView(ctx *ui.Context, page *boardPage, freeform bool) {
	autoHide := page.Kind == ""
	if s.boardScrollTop {
		s.boardScroll.Y = 0
		s.boardScrollTop = false
	}
	scroll := ui.Scroll(ctx).Fill().TrackScroll(&s.boardScroll).Label("白板页面")
	scroll.Draw(func(p *ui.Painter, r ui.Rect) {
		if absf(r.H-s.board.paneH) > 0.5 {
			s.board.paneH = r.H
			s.frame()
		}
	})
	scroll.Children(func() {
		content := max(s.board.paneH, s.boardNodeMinHeight(&page.Layout)+2*boardPagePadding)
		column := ui.Column(ctx).FillWidth().Height(content).Padding(boardPagePadding)
		column.Children(func() {
			node := &page.Layout
			if node.Kind == "split" && node.Axis == "column" && len(node.Children) > 1 {
				s.boardSizedRows(ctx, node, "root", freeform, autoHide, content-2*boardPagePadding)
				return
			}
			s.boardNodeView(ctx, node, "root", freeform, autoHide)
		})
	})
}

func (s *shellState) boardSizedRows(ctx *ui.Context, node *boardNode, path string, freeform, autoHide bool, total float32) {
	weights := make([]float32, len(node.Children))
	minimums := make([]float32, len(node.Children))
	for index := range node.Children {
		weights[index] = node.Children[index].Weight
		minimums[index] = s.boardNodeMinHeight(&node.Children[index].Node)
	}
	heights := boardSizedColumn(weights, minimums, total-float32(len(node.Children)-1)*boardDividerGap)
	container := ui.Column(ctx).FillWidth().Height(total)
	container.Draw(func(p *ui.Painter, r ui.Rect) { s.board.splits[path] = r })
	container.Children(func() {
		for index := range node.Children {
			if index > 0 {
				s.boardDivider(ctx, node, path, index-1)
			}
			slot := node.Children[index]
			cell := ui.Row(ctx).FillWidth().Height(heights[index])
			cell.Children(func() {
				s.boardNodeView(ctx, &slot.Node, path+"/"+strconv.Itoa(index), freeform, autoHide)
			})
		}
	})
}
