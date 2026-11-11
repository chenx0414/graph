package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

func Tabs(c *ui.Context, sel *int, labels ...string) ui.Element {
	return segmented(c, sel, false, labels)
}

func TabsFill(c *ui.Context, sel *int, labels ...string) ui.Element {
	return segmented(c, sel, true, labels)
}

func segmented(c *ui.Context, sel *int, fill bool, labels []string) ui.Element {
	t, th := theme.Of(c), c.Theme()
	tabs := ui.TabsBase(c, sel, len(labels))
	return tabs.List.Padding(th.Space(0.5)).Radius(t.Radius.Lg).Background(t.Hover).Gap(th.Space(0.5)).Children(func() {
		for i, l := range labels {
			tab := tabs.Tab(i).Height(th.Space(6.5)).PaddingX(th.Space(2.5)).Radius(t.Radius.Md).FontSize(t.Text.Sm).FontWeight(400).TextColor(t.Muted).Transition(colors(theme.MotionFast))
			if fill {
				tab.Grow(1).Basis(0).Justify(ui.Center)
			}
			if i == *sel {
				Elevate(c, tab.Background(t.Background).TextColor(t.Foreground), theme.ShadowSm)
			}
			tab.Children(func() { ui.Text(c, l) })
		}
	})
}

