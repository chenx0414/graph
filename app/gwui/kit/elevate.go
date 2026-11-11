package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

func Elevate(c *ui.Context, e ui.Element, s theme.Elevation) ui.Element {
	ink := ink(theme.Of(c))
	for _, l := range s {
		e.Shadow(0, l.Y, l.Blur, l.Spread, ink.Alpha(l.Alpha))
	}
	return e
}
