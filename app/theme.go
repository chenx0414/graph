package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

var (
	boardDot   = gwtheme.Light().Grid
	cardGap    = float32(8)
	railWidth  = float32(62)
	listWidth  = float32(236)
	cardRadius = float32(12)
)

func applyTheme(c *ui.Context) {
	gwtheme.Apply(c, gwtheme.FromAppearance(c.Theme().Dark))
}
