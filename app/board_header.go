package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

func iconAction(ctx *ui.Context, icon *ui.SVG, label string, selected bool, size float32, action func()) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	button := ui.Box(ctx).Size(th.Space(size), th.Space(size)).Radius(t.Radius.Md).Center().
		Label(label).Tooltip(label).Focusable()
	if action != nil {
		button.OnClick(action)
	}
	color := t.Muted
	switch {
	case selected:
		button.Background(t.SidebarSelected)
		color = t.Foreground
	case button.Hovered():
		button.Background(t.HoverTint)
		color = t.Foreground
	}
	button.Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(color)
	})
	return button
}
