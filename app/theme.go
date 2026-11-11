package main

import "github.com/egoist/mygo/ui"

var graphTheme = appTheme()

var (
	boardDot      = ui.RGB(229, 219, 238)
	cardShadow    = ui.RGBA(23, 31, 58, 0.07)
	cardGap       = float32(12)
	railWidth     = float32(64)
	listWidth     = float32(232)
	cardRadius    = float32(16)
	controlRadius = float32(12)
)

func appTheme() *ui.Theme {
	t := ui.LightTheme()
	t.Background = ui.Hex("#F2F3F8")
	t.Surface = ui.Hex("#FFFFFF")
	t.SurfaceHover = ui.Hex("#F6F7FC")
	t.Border = ui.Hex("#E5E7F0")
	t.Text = ui.Hex("#1C2436")
	t.TextMuted = ui.Hex("#8B93A6")
	t.Accent = ui.Hex("#2F5BFF")
	t.AccentHover = ui.Hex("#4A70FF")
	t.AccentPressed = ui.Hex("#2247D8")
	t.AccentText = ui.Hex("#FFFFFF")
	t.Selection = ui.RGBA(47, 91, 255, 0.20)
	t.Scrollbar = ui.Hex("#C9CEDD")
	t.Radius = controlRadius
	t.Spacing = 4
	t.FontSize = 13
	return t
}
