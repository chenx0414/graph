package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const (
	chatPaneMinWidth     = float32(300)
	whiteboardFloorWidth = float32(610)
)

func windowFloorWidth() int {
	th := ui.LightTheme()
	width := railWidth + th.Space(1.25) + listWidth + gwtheme.Stroke +
		chatPaneMinWidth + gwtheme.Stroke + whiteboardFloorWidth + cardGap
	return int(width + 0.5)
}

func windowFloorHeight() int {
	return 640
}
