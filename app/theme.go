package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

var (
	boardDot   = gwtheme.Light().Grid
	cardGap    = float32(8)
	railWidth  = float32(62)
	listWidth  = float32(236)
	cardRadius = float32(12)
)

func userBubble(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.Blue950.Color().Mix(palette.Neutral900.Color(), 0.6)
	}
	return palette.Blue100.Color().Mix(palette.White.Color(), 0.45)
}

func applyTheme(c *ui.Context) {
	gwtheme.Apply(c, gwtheme.FromAppearance(c.Theme().Dark))
}
