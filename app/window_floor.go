package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const (
	chatPaneMinWidth     = float32(300)
	whiteboardFloorWidth = float32(610)
	windowFloorHeight    = 640
)

func windowFloorWidth(floor float32) int {
	th := ui.LightTheme()
	width := railWidth + th.Space(1.25) + listWidth + gwtheme.Stroke +
		chatPaneMinWidth + gwtheme.Stroke + floor + cardGap
	return int(width + 0.5)
}

func (s *shellState) whiteboardFloorWidth() float32 {
	if s.windowFloor > 0 {
		return s.windowFloor
	}
	return whiteboardFloorWidth
}

func (s *shellState) trackWindowFloor(ctx *ui.Context) {
	if s.windowFloor > 0 {
		return
	}
	chrome := boardCardChrome(ctx) + ctx.Theme().Space(2.5)*2
	widest := float32(0)
	for _, kind := range boardPanelAllKinds() {
		panel := boardPanel{ID: kind, Kind: kind}
		widest = max(widest, s.boardPanelMinWidth(ctx, &panel))
	}
	widest = max(widest, boardDefaultMinWidth*2)
	s.windowFloor = max(whiteboardFloorWidth, widest+chrome)
	if s.window != nil {
		s.window.SetMinimumSize(windowFloorWidth(s.windowFloor), windowFloorHeight)
	}
}
