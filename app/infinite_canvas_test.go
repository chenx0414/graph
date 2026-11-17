package main

import (
	"math"
	"testing"
)

func TestFitBoundsUsesTheCardBox(t *testing.T) {
	view := &infiniteCanvas{}
	view.fitBounds(canvasFitBox{X: 300, Y: 300, W: 600, H: 160}, 730, 355)
	if view.zoom < 1.05 || view.zoom > 1.2 {
		t.Fatalf("a 600x160 card box should use the panel, zoom %f", view.zoom)
	}
	cx := view.x + (300+300)*view.zoom
	cy := view.y + (300+80)*view.zoom
	if math.Abs(float64(cx-365)) > 0.5 || math.Abs(float64(cy-177.5)) > 0.5 {
		t.Fatalf("the card box must be centered, center %f,%f", cx, cy)
	}
}

func TestNetworkSceneBoundsTrackItsCards(t *testing.T) {
	scene := netScene{
		width: 900, height: 760,
		nodes: []fleetRingNode{
			{X: 300, Y: 300, W: 200, H: 100},
			{X: 520, Y: 320, W: 100, H: 80},
		},
	}
	box := scene.bounds()
	if box.X != 300 || box.Y != 300 || box.W != 320 || box.H != 100 {
		t.Fatalf("bounds must cover the cards, got %+v", box)
	}
}
