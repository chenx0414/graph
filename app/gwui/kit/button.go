package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

type Variant int

const (
	Default Variant = iota
	Secondary
	Outline
	Ghost
	Destructive
	Link
	DestructiveOutline
)

type ButtonSize int

const (
	SizeDefault ButtonSize = iota
	SizeXs
	SizeSm
	SizeLg
)

type ButtonOpts struct {
	Variant  Variant
	Size     ButtonSize
	Disabled bool
	Flat     bool
	Icon     *ui.SVG
	Trailing *ui.SVG
}

func button(c *ui.Context, o ButtonOpts, square bool) ui.Element {
	t, th := theme.Of(c), c.Theme()
	h, padX := th.Space(8), th.Space(3.5)
	switch o.Size {
	case SizeXs:
		if square {
			h, padX = th.Space(4), th.Space(1.5)
		}
	case SizeSm:
		h, padX = th.Space(7), th.Space(2.5)
	case SizeLg:
		h, padX = th.Space(9), th.Space(4.5)
	}
	b := ui.ButtonBase(c).Disabled(o.Disabled).DimDisabled(false)
	b.Gap(th.Space(1.5)).Justify(ui.Center).Transition(colors(theme.MotionFast))
	if o.Variant == Link {
		b.TextColor(t.Muted)
		if o.Disabled {
			b.TextColor(t.Idle)
		}
		if o.Size == SizeSm {
			b.FontSize(t.Text.Sm)
		}
		if b.Hovered() && !o.Disabled {
			b.TextColor(t.Foreground).Underline()
		}
		return b
	}
	b.Height(h).Radius(t.Radius.Lg)
	if square {
		b.Width(h).Radius(t.Radius.Md)
		if o.Size == SizeXs {
			b.Radius(t.Radius.Full)
		}
	} else {
		b.PaddingX(padX)
	}
	hover := b.Hovered() && !o.Disabled
	switch o.Variant {
	case Default:
		b.Background(t.Primary).TextColor(t.PrimaryText).FontWeight(500)
		if hover {
			b.Background(t.Primary.Mix(t.Background, 0.1))
		}
	case Secondary:
		b.Background(t.Hover).TextColor(t.Foreground)
		if hover {
			b.Background(t.SidebarSelected)
		}
	case Outline:
		b.Background(t.Background).Border(theme.Stroke, t.Input).TextColor(t.Foreground)
		if !o.Flat {
			Elevate(c, b, theme.ShadowXs)
		}
		if hover {
			b.Background(t.Hover)
		}
	case Ghost:
		b.TextColor(t.Foreground)
		if square {
			b.TextColor(t.Muted)
		}
		if hover {
			b.Background(t.HoverTint).TextColor(t.Foreground)
		}
	case Destructive:
		b.TextColor(t.Danger)
		if hover {
			b.Background(t.DangerBg)
		}
	case DestructiveOutline:
		b.Background(t.Background).Border(theme.Stroke, t.DangerBorder).TextColor(t.Danger)
		if hover {
			b.Background(t.DangerBg)
		}
	}
	if o.Disabled {
		b.TextColor(t.Idle)
		if o.Variant == Default {
			b.Background(t.Primary.Alpha(0.5)).TextColor(t.PrimaryText.Alpha(0.5))
		}
	}
	return b
}

func ButtonFrame(c *ui.Context, o ButtonOpts) ui.Element { return button(c, o, false) }

func Button(c *ui.Context, label string, o ButtonOpts) ui.Element {
	return button(c, o, false).Label(label).Children(func() {
		if o.Icon != nil {
			ui.Icon(c, o.Icon).Size(theme.Icon, theme.Icon)
		}
		ui.Text(c, label)
		if o.Trailing != nil {
			ui.Icon(c, o.Trailing).Size(theme.IconSm, theme.IconSm)
		}
	})
}

func IconButton(c *ui.Context, icon *ui.SVG, label string, o ButtonOpts) ui.Element {
	b := button(c, o, true).Label(label)
	tooltip(c, b, label, false)
	size := float32(theme.Icon)
	if o.Size == SizeXs {
		size = theme.IconXs
	}
	return b.Children(func() {
		ui.Icon(c, icon).Size(size, size)
	})
}

func TextLink(c *ui.Context, label string, color ui.Color, size float32) ui.Element {
	return ui.ButtonBase(c).Label(label).Children(func() {
		Text(c, label, size).TextColor(color).Underline()
	})
}

