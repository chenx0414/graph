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
	restTop    bool
	restBottom bool
}

func (e *edgeScroll) restingAtStart() bool {
	if e.MaxY <= 0 {
		return false
	}
	if e.Y <= fadeRestThreshold {
		e.restTop = true
	} else if e.Y > fadeLeaveSlack {
		e.restTop = false
	}
	return e.restTop
}

func (e *edgeScroll) restingAtEnd() bool {
	if e.MaxY <= 0 {
		return false
	}
	if e.MaxY-e.Y <= fadeRestThreshold {
		e.restBottom = true
	} else if e.MaxY-e.Y > fadeLeaveSlack {
		e.restBottom = false
	}
	return e.restBottom
}

func (e *edgeScroll) insets() (top, bottom float32) {
	if e == nil || e.MaxY <= 0 {
		return 0, 0
	}
	if e.restingAtStart() {
		top = fadeEdgeClearance
	}
	if e.restingAtEnd() {
		bottom = fadeEdgeClearance
	}
	return top, bottom
}

func (e *edgeScroll) mask() ui.LinearGradient {
	gradient := ui.LinearGradient{Angle: 180, Stops: []ui.GradientStop{
		{Color: ui.Transparent, At: 0},
		{Color: ui.RGB(0, 0, 0), At: fadeBand},
		{Color: ui.RGB(0, 0, 0), At: 1 - fadeBand},
		{Color: ui.Transparent, At: 1},
	}}
	if e == nil || e.MaxY <= 0 {
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
