package main

import (
	"image"
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

func TestDropZoneFollowsTheOuterQuarter(t *testing.T) {
	for _, sample := range []struct {
		x, y float32
		edge string
	}{
		{0.1, 0.5, "left"},
		{0.9, 0.5, "right"},
		{0.5, 0.1, "top"},
		{0.5, 0.9, "bottom"},
		{0.5, 0.5, "center"},
		{0.3, 0.3, "center"},
		{0.2, 0.4, "left"},
	} {
		if got := boardDropEdge(sample.x, sample.y); got != sample.edge {
			t.Fatalf("drop zone at (%.2f,%.2f) = %q, want %q", sample.x, sample.y, got, sample.edge)
		}
	}
}

func TestTheDropPreviewFillsTheExactHalfOfTheTarget(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	state.board.drag = &boardDrag{panelID: "overview", target: "agent", edge: "left"}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	target := state.board.rects["agent"]
	if target.W <= 0 {
		t.Fatalf("the target partition was never measured: %+v", state.board.rects)
	}
	accent := gwtheme.Light().Unread
	tint := blendTint(gwtheme.Light().Background, accent, 0.18)
	leftEdge := ui.Rect{X: target.X, Y: target.Y, W: target.W / 2, H: target.H}
	rightEdge := ui.Rect{X: target.X + target.W/2, Y: target.Y, W: target.W / 2, H: target.H}
	leftSide := countColorIn(tester.Image(), tint, leftEdge)
	rightSide := countColorIn(tester.Image(), tint, rightEdge)
	if leftSide < 1000 || rightSide*10 > leftSide {
		t.Fatalf("the left edge preview fills the left half only, left %d right %d", leftSide, rightSide)
	}
	state.board.drag = &boardDrag{panelID: "overview", target: "agent", edge: "center"}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	leftSide = countColorIn(tester.Image(), blendTint(gwtheme.Light().Background, accent, 0.18), leftEdge)
	rightSide = countColorIn(tester.Image(), blendTint(gwtheme.Light().Background, accent, 0.18), rightEdge)
	if leftSide < 1000 || rightSide < 1000 {
		t.Fatalf("a center drop previews the whole pane, left %d right %d", leftSide, rightSide)
	}
}

func blendTint(base, accent ui.Color, alpha float32) ui.Color {
	blend := func(background, foreground uint8) uint8 {
		return uint8(math.Round(float64(background)*(1-float64(alpha)) + float64(foreground)*float64(alpha)))
	}
	return ui.Color{R: blend(base.R, accent.R), G: blend(base.G, accent.G), B: blend(base.B, accent.B), A: 255}
}

func countColorIn(img *image.RGBA, want ui.Color, rect ui.Rect) int {
	count := 0
	bounds := img.Bounds()
	for y := int(rect.Y); y < int(rect.Y+rect.H); y++ {
		for x := int(rect.X); x < int(rect.X+rect.W); x++ {
			if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
				continue
			}
			at := img.PixOffset(x, y)
			if img.Pix[at] == want.R && img.Pix[at+1] == want.G && img.Pix[at+2] == want.B && img.Pix[at+3] == want.A {
				count++
			}
		}
	}
	return count
}
