package kit

import (
	"sync"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

var soft sync.Map

func List(c *ui.Context, s *ui.ListState, n int, row func(i int)) ui.Element {
	if s.Reorder != nil && s.Selected == nil && s.Selection == nil {
		return ui.List(c, s, n, row)
	}
	base := c.Theme()
	q, ok := soft.Load(base)
	if !ok {
		t, th := theme.Of(c), *base
		th.Accent, th.AccentText = t.SidebarSelected, t.Foreground
		th.SurfaceHover = t.Hover.Mix(t.Background, 0.5)
		q, _ = soft.LoadOrStore(base, &th)
	}
	c.SetTheme(q.(*ui.Theme))
	defer c.SetTheme(base)
	return ui.List(c, s, n, func(i int) {
		c.SetTheme(base)
		row(i)
		c.SetTheme(q.(*ui.Theme))
	})
}
