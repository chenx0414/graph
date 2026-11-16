package kit

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

const SkeletonLabel = "加载占位"

func skeleton(c *ui.Context, height float32, width func(ui.Element) ui.Element) ui.Element {
	t, th := theme.Of(c), c.Theme()
	radius := height / 2
	if radius > th.Space(1.25) {
		radius = th.Space(1.25)
	}
	base := t.Hover
	highlight := base.Mix(t.Foreground, 0.09)
	bar := ui.Box(c).Height(height).Radius(radius).Background(base).Clip().Label(SkeletonLabel)
	bar = width(bar)
	timeline := bar.Timeline("skeleton", ui.TimelineOptions{Repeat: ui.RepeatForever})
	shift := timeline.Tween(ui.Tween{From: 0, To: 1, Duration: theme.SkeletonPulse, Ease: ui.EaseInOut})
	bar.Children(func() {
		band := ui.Box(c).Absolute().Top(0).Left(0).WidthPercent(70).FillHeight().
			LinearGradient(ui.LinearGradient{Angle: 90, Stops: []ui.GradientStop{
				{Color: base, At: 0},
				{Color: highlight, At: 0.5},
				{Color: base, At: 1},
			}})
		band.TranslatePercent(-150+300*shift, 0)
	})
	return bar
}

func SkeletonLine(c *ui.Context, widthPercent float32, height float32) ui.Element {
	return skeleton(c, height, func(e ui.Element) ui.Element {
		if widthPercent <= 0 {
			return e.FillWidth()
		}
		return e.WidthPercent(widthPercent)
	})
}

func SkeletonBlock(c *ui.Context, width float32, height float32) ui.Element {
	return skeleton(c, height, func(e ui.Element) ui.Element { return e.Width(width) })
}

func SkeletonCircle(c *ui.Context, size float32) ui.Element {
	return skeleton(c, size, func(e ui.Element) ui.Element { return e.Size(size, size) })
}
