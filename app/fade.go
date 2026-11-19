package main

import "github.com/egoist/mygo/ui"

const (
	fadeEdgeClearance = float32(12)
	fadeBand          = float32(0.08)
	fadeRestThreshold = float32(0.5)
	fadeLeaveSlack    = float32(24)
)

type edgeScroll struct {
	ui.ScrollState
	viewport   float32
	content    float32
	measured   bool
	restTop    bool
	restBottom bool
	padTop     float32
	padBottom  float32
}

func (e *edgeScroll) measure() {
	if e.MaxY <= 0 || e.viewport <= 0 {
		return
	}
	e.content = e.MaxY + e.viewport - e.padTop - e.padBottom
	e.measured = true
}

func (e *edgeScroll) fits() bool {
	return e.measured && e.content <= e.viewport
}

func (e *edgeScroll) restingAtStart() bool {
	if e.Y <= fadeRestThreshold {
		e.restTop = true
	} else if e.Y > fadeLeaveSlack {
		e.restTop = false
	}
	return e.restTop
}

func (e *edgeScroll) restingAtEnd() bool {
	if e.MaxY-e.Y <= fadeRestThreshold {
		e.restBottom = true
	} else if e.MaxY-e.Y > fadeLeaveSlack {
		e.restBottom = false
	}
	return e.restBottom
}

func (e *edgeScroll) insets() (top, bottom float32) {
	if e == nil {
		return 0, 0
	}
	e.measure()
	switch {
	case e.viewport <= 0 || !e.measured:
		top, bottom = fadeEdgeClearance, fadeEdgeClearance
	case e.fits():
		room := min(fadeEdgeClearance, (e.viewport-e.content)/2)
		top, bottom = room, room
	default:
		if e.restingAtStart() {
			top = fadeEdgeClearance
		}
		if e.restingAtEnd() {
			bottom = fadeEdgeClearance
		}
	}
	e.padTop, e.padBottom = top, bottom
	return top, bottom
}

func (e *edgeScroll) mask() ui.LinearGradient {
	if e != nil && !e.measured {
		e.measure()
	}
	gradient := ui.LinearGradient{Angle: 180, Stops: []ui.GradientStop{
		{Color: ui.Transparent, At: 0},
		{Color: ui.RGB(0, 0, 0), At: fadeBand},
		{Color: ui.RGB(0, 0, 0), At: 1 - fadeBand},
		{Color: ui.Transparent, At: 1},
	}}
	if e == nil || e.viewport <= 0 || !e.measured || e.fits() {
		gradient.Stops[1].At, gradient.Stops[2].At = 0, 1
		return gradient
	}
	if e.restingAtStart() {
		gradient.Stops[1].At = 0
	}
	if e.restingAtEnd() {
		gradient.Stops[2].At = 1
	}
	return gradient
}
