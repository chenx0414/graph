package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const (
	chatPaneMinWidth     = float32(300)
	whiteboardPaneMin    = float32(320)
	windowFloorHeight    = 640
	whiteboardFloorFloor = float32(320)
)

func (s *shellState) whiteboardPaneMinWidth() float32 {
	return max(whiteboardPaneMin, s.windowFloor)
}

func (s *shellState) whiteboardPaneWidth() float32 {
	return whiteboardPaneMin
}

func windowFloorWidth(whiteboard float32) int {
	th := ui.LightTheme()
	width := railWidth + th.Space(1.25) + listWidth + gwtheme.Stroke +
		chatPaneMinWidth + gwtheme.Stroke + whiteboard + cardGap
	return int(width + 0.5)
}

func (s *shellState) windowFloorWidth() int {
	return windowFloorWidth(s.whiteboardPaneMinWidth())
}

func (s *shellState) standardPageLayouts() []boardNode {
	layouts := []boardNode{defaultBoardLayout(), trajectoryPageLayout(trajectoryPageKinds())}
	for _, kind := range boardPanelAllKinds() {
		if kind == "context-overview" || kind == "agent-network" || kind == "fleet-collaboration" {
			continue
		}
		layouts = append(layouts, boardNode{Kind: "panel", PanelID: kind})
	}
	return layouts
}

func (s *shellState) standardLayoutMinWidth(ctx *ui.Context, node *boardNode) float32 {
	switch node.Kind {
	case "panel":
		return s.boardPanelMinWidth(ctx, &boardPanel{ID: node.PanelID, Kind: node.PanelID})
	case "split":
		if node.Axis == "row" {
			total := float32(0)
			for index := range node.Children {
				total += s.standardLayoutMinWidth(ctx, &node.Children[index].Node)
			}
			return total
		}
		widest := float32(0)
		for index := range node.Children {
			widest = max(widest, s.standardLayoutMinWidth(ctx, &node.Children[index].Node))
		}
		return widest
	}
	return boardDefaultMinWidth
}

func (s *shellState) trackWindowFloor(ctx *ui.Context) {
	if s.windowFloor > 0 {
		return
	}
	chrome := boardCardChrome(ctx) + ctx.Theme().Space(2.5)*2
	widest := float32(0)
	layouts := s.standardPageLayouts()
	for index := range layouts {
		widest = max(widest, s.standardLayoutMinWidth(ctx, &layouts[index]))
	}
	s.windowFloor = max(whiteboardFloorFloor, widest+chrome)
	if s.window != nil {
		s.window.SetMinimumSize(s.windowFloorWidth(), windowFloorHeight)
	}
}
