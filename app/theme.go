package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

var (
	cardGap         = float32(8)
	railWidth       = float32(40)
	listWidth       = float32(236)
	bandHeight      = float32(44)
	boardCardHeight = float32(224)
	cardRadius      = float32(12)
)

var shellShadow = gwtheme.Elevation{
	{Y: 0, Blur: 0, Spread: 1, Alpha: 0x11 / 255.0},
	{Y: 10, Blur: 28, Spread: -8, Alpha: 0x1a / 255.0},
	{Y: 4, Blur: 10, Spread: -4, Alpha: 0x14 / 255.0},
}

var composerShadow = gwtheme.Elevation{
	{Y: 0, Blur: 0, Spread: 1, Alpha: 0x0d / 255.0},
	{Y: 4, Blur: 16, Spread: -2, Alpha: 0x14 / 255.0},
	{Y: 2, Blur: 5, Spread: 0, Alpha: 0x0d / 255.0},
}

func pageBackdrop(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.Neutral950.Color()
	}
	return palette.Neutral200.Color().Mix(palette.White.Color(), 0.35)
}

func columnLine(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.White.Color().Alpha(0.08)
	}
	return palette.Black.Color().Alpha(0.06)
}

func userBubble(t gwtheme.Tokens) ui.Color {
	if t.Dark {
		return palette.Blue950.Color().Mix(palette.Neutral900.Color(), 0.6)
	}
	return palette.Blue100.Color().Mix(palette.White.Color(), 0.45)
}

func applyTheme(c *ui.Context) {
	gwtheme.Apply(c, gwtheme.FromAppearance(c.Theme().Dark))
}
