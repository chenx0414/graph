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

func octopusTile(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.Violet950.Color()
	}
	return palette.Violet100.Color()
}

func octopusInk(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.Violet300.Color()
	}
	return palette.Violet700.Color()
}

func applyTheme(c *ui.Context) {
	gwtheme.Apply(c, gwtheme.FromAppearance(c.Theme().Dark))
}
