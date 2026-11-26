package main

import (
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type trajectorySlice struct {
	Label   string
	Value   float64
	Display string
	Color   ui.Color
}

func (s *shellState) trajectoryData(ctx *ui.Context) *conversationTrajectory {
	t := gwtheme.Of(ctx)
	state := &s.trajectory
	if state.data != nil && state.scopeKey == s.chatScope().key() {
		return state.data
	}
	if state.data != nil && !state.loading() {
		onUI(s.window, s.ensureTrajectory)
	}
	if state.failed != "" {
		kit.Text(ctx, state.failed, t.Text.Sm).TextColor(t.Muted)
	} else {
		skeletonCard(ctx, 3, false, true)
	}
	if !state.loading() && (state.failed == "" || state.scopeKey != s.chatScope().key()) {
		onUI(s.window, s.ensureTrajectory)
	}
	return nil
}

func trajectoryCardHeader(ctx *ui.Context, icon *ui.SVG, meta string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
	row.Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
		ui.Spacer(ctx)
		if meta != "" {
			kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
	})
}

func trajectoryStatCell(ctx *ui.Context, label, value string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	cell := ui.Column(ctx).Grow(1).Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
	cell.Children(func() {
		kit.Text(ctx, value, t.Text.Sm).FontWeight(600).SingleLine().Ellipsis("…")
		kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	})
}

func trajectoryStatGrid(ctx *ui.Context, rows [][][2]string) {
	th := ctx.Theme()
	for _, row := range rows {
		group := row
		ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
			for _, cell := range group {
				trajectoryStatCell(ctx, cell[0], cell[1])
			}
		})
	}
}

func trajectoryDonutLegend(ctx *ui.Context, slices []trajectorySlice, centerTop, centerSub string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	total := 0.0
	for _, slice := range slices {
		if slice.Value > 0 {
			total += slice.Value
		}
	}
	row := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
	row.Children(func() {
		donut := ui.Box(ctx).Size(th.Space(22), th.Space(22))
		donut.Draw(func(p *ui.Painter, r ui.Rect) {
			cx, cy := r.X+r.W/2, r.Y+r.H/2
			outer, inner := r.W/2, r.W/2*0.62
			angle := float32(-math.Pi / 2)
			gap := float32(0.03)
			for _, slice := range slices {
				if slice.Value <= 0 {
					continue
				}
				sweep := float32(slice.Value/total) * 2 * float32(math.Pi)
				path := &ui.Path{}
				trajectoryWedge(path, cx, cy, outer, inner, angle+gap/2, angle+sweep-gap/2)
				p.FillPath(path, slice.Color)
				angle += sweep
			}
		})
		donut.Children(func() {
			ui.Column(ctx).Fill().Center().Children(func() {
				kit.Text(ctx, centerTop, t.Text.Sm).FontWeight(600).SingleLine().
					Width(th.Space(20)).TextAlign(ui.Center).Ellipsis("…")
				kit.Text(ctx, centerSub, t.Text.Xs).TextColor(t.Muted).TextAlign(ui.Center)
			})
		})
		legend := ui.Column(ctx).Grow(1).Gap(th.Space(1))
		legend.Children(func() {
			for _, slice := range slices {
				share := 0.0
				if total > 0 {
					share = slice.Value / total * 100
				}
				line := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center)
				line.Children(func() {
					ui.Box(ctx).Size(th.Space(2), th.Space(2)).Radius(t.Radius.Full).Background(slice.Color)
					kit.Text(ctx, slice.Label, t.Text.Xs).Grow(1).SingleLine().Ellipsis("…")
					kit.Text(ctx, slice.Display, t.Text.Xs).TextColor(t.Muted)
					kit.Text(ctx, strconv.FormatFloat(share, 'f', 1, 64)+"%", t.Text.Xs).TextColor(t.Muted)
				})
			}
		})
	})
}

func trajectoryWedge(path *ui.Path, cx, cy, outer, inner, start, end float32) {
	if end <= start {
		return
	}
	steps := int(math.Max(2, math.Ceil(float64((end-start)/0.10))))
	point := func(radius, angle float32) (float32, float32) {
		return cx + radius*float32(math.Cos(float64(angle))), cy + radius*float32(math.Sin(float64(angle)))
	}
	x, y := point(outer, start)
	path.MoveTo(x, y)
	for index := 1; index <= steps; index++ {
		x, y = point(outer, start+(end-start)*float32(index)/float32(steps))
		path.LineTo(x, y)
	}
	x, y = point(inner, end)
	path.LineTo(x, y)
	for index := steps - 1; index >= 0; index-- {
		x, y = point(inner, start+(end-start)*float32(index)/float32(steps))
		path.LineTo(x, y)
	}
	path.Close()
}
