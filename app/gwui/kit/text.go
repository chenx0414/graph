package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

func Text(c *ui.Context, s string, size float32) ui.Element {
	return ui.Text(c, s).FontSize(size).LineHeight(theme.Of(c).Text.Line(size))
}

func Badge(c *ui.Context, text string) ui.Element {
	t, th := theme.Of(c), c.Theme()
	return ui.Box(c).Padding(th.Space(0.5), th.Space(2)).Radius(t.Radius.Sm).Background(t.Hover).Children(func() {
		Text(c, text, t.Text.Sm).TextColor(t.Foreground)
	})
}

type Status int

const (
	OK Status = iota
	Attention
	Error
)

func StatusDot(c *ui.Context, s Status) ui.Element {
	t := theme.Of(c)
	color := t.Success
	switch s {
	case Attention:
		color = t.Attention
	case Error:
		color = t.Danger
	}
	return ui.Box(c).Size(theme.StatusDot, theme.StatusDot).Radius(t.Radius.Full).Background(color)
}

func Spinner(c *ui.Context) ui.Element {
	return ui.Spinner(c).TextColor(theme.Of(c).Muted)
}

func Separator(c *ui.Context, vertical bool) ui.Element {
	t := theme.Of(c)
	if vertical {
		return ui.Box(c).Width(theme.Hairline).FillHeight().Background(t.Border)
	}
	return ui.Box(c).Height(theme.Hairline).FillWidth().Background(t.Border)
}
