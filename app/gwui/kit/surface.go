package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

type SidebarItemOpts struct {
	Selected bool
	Covered  bool
	Muted    bool
	Small    bool
	Indent   float32
	OnClick  func()
}

func SidebarItem(c *ui.Context, o SidebarItemOpts) ui.Element {
	t, th := theme.Of(c), c.Theme()
	b := ui.ButtonBase(c).Height(th.Space(8)).Padding(0, th.Space(2), 0, th.Space(2+o.Indent)).Gap(th.Space(2)).Radius(t.Radius.Lg).Justify(ui.Start).Transition(colors(theme.MotionFast))
	if o.Small {
		b.Height(th.Space(7.5)).Gap(th.Space(1.5)).FontSize(t.Text.Sm)
	}
	if o.Muted {
		b.TextColor(t.Muted)
	}
	switch {
	case o.Selected && b.Hovered():
		b.Background(t.HoverTint.Alpha(2.25))
	case o.Selected:
		b.Background(t.HoverTint.Alpha(1.75))
	case b.Hovered():
		b.Background(t.HoverTint)
	}
	if o.OnClick != nil && (!o.Selected || o.Covered) {
		b.OnClick(o.OnClick)
	}
	return b
}

func SidebarIcon(c *ui.Context, item ui.Element, icon *ui.SVG, selected bool) {
	t := theme.Of(c)
	svg, color := icon, t.Muted
	if selected {
		svg, color = icon, t.Foreground
	} else if item.Hovered() {
		color = t.Foreground
	}
	ui.Icon(c, svg).Size(theme.Icon, theme.Icon).TextColor(color)
}

func Card(c *ui.Context, body func()) ui.Element {
	t, th := theme.Of(c), c.Theme()
	card := ui.Column(c).Gap(th.Space(3)).Padding(th.Space(4)).Radius(t.Radius.Xl).Background(t.Background).Border(theme.Hairline, t.Border)
	return Elevate(c, card, theme.ShadowSm).Children(body)
}

type PressableOpts struct {
	Selected, Bordered bool
	Glass              bool
	Bare               bool
	OnClick            func()
}

func Pressable(c *ui.Context, o PressableOpts) ui.Element {
	t := theme.Of(c)
	b := ui.ButtonBase(c).Justify(ui.Start).Radius(t.Radius.Lg).Transition(colors(theme.MotionFast))
	if o.Glass {
		tint := t.GlassBg
		if b.Hovered() {
			tint = t.GlassHover
		}
		b.Radius(t.Radius.Lg).Clip().
			Background(tint).
			Border(theme.Hairline, t.GlassBorder)
		Elevate(c, b, theme.ShadowXs)
	} else if o.Bordered {
		b.Border(theme.Stroke, t.Border).Background(t.Background)
	}
	if !o.Bare && !o.Glass {
		switch {
		case o.Selected:
			b.Background(t.SidebarSelected)
		case b.Hovered():
			b.Background(t.Hover)
		}
	}
	if o.OnClick != nil && !o.Selected {
		b.OnClick(o.OnClick)
	}
	return b
}

func Panel(c *ui.Context, radius float32) ui.Element {
	t := theme.Of(c)
	return Elevate(c, ui.Column(c).Radius(radius).Clip().Background(t.Background).Border(theme.Hairline, t.Border), theme.ShadowXs)
}

func CardHeader(c *ui.Context, title, description string) {
	t, th := theme.Of(c), c.Theme()
	ui.Column(c).Gap(th.Space(1)).Children(func() {
		Text(c, title, t.Text.Lg).FontWeight(600)
		if description != "" {
			Text(c, description, t.Text.Sm).TextColor(t.Muted)
		}
	})
}

func CardFooter(c *ui.Context, children func()) {
	ui.Row(c).Justify(ui.End).Gap(c.Theme().Space(2)).Children(children)
}
