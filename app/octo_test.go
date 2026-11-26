package main

import (
	"bytes"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

func TestOctoSwimPlaysItsEightFramesOutAndBack(t *testing.T) {
	lifts := []int{0, 0, 1, 1, 2, 1, 1, 0}
	for frame := range lifts {
		at := time.Duration(frame)*octoSwimStep + octoSwimStep/2
		got, lift := octoFrameAt(at)
		if got != frame || lift != lifts[frame] {
			t.Fatalf("frame %d: got frame %d lift %d, want frame %d lift %d", frame, got, lift, frame, lifts[frame])
		}
	}
}

func TestOctoBlinksAndGlances(t *testing.T) {
	if octoExpressionAt(1 * time.Second).Blink {
		t.Fatal("the octopus blinks only in its blink window")
	}
	if !octoExpressionAt(4400 * time.Millisecond).Blink {
		t.Fatal("the octopus must blink near the end of its 4.6s clock")
	}
	if look := octoExpressionAt(1600 * time.Millisecond).Look; look != -1 {
		t.Fatalf("the octopus looks left in its first window, got %d", look)
	}
	if look := octoExpressionAt(4300 * time.Millisecond).Look; look != 1 {
		t.Fatalf("the octopus looks right in its second window, got %d", look)
	}
	if look := octoExpressionAt(1 * time.Second).Look; look != 0 {
		t.Fatalf("the octopus looks nowhere between its windows, got %d", look)
	}
}

func TestOctoAsksForTheNextFrameAtTheNextChange(t *testing.T) {
	if wait := octoNextPaint(0); wait != octoSwimStep {
		t.Fatalf("a fresh frame waits a whole swim step, got %v", wait)
	}
	if wait := octoNextPaint(100 * time.Millisecond); wait != octoSwimStep-100*time.Millisecond {
		t.Fatalf("mid-step waits the rest of the step, got %v", wait)
	}
	if wait := octoNextPaint(4380 * time.Millisecond); wait > 20*time.Millisecond {
		t.Fatalf("a blink starting in 13ms is the next paint, got %v", wait)
	}
}

func TestTheOctopusFloatsOnItsBackground(t *testing.T) {
	view := func(c *ui.Context) {
		applyTheme(c)
		ui.Box(c).Fill().Background(gwtheme.Light().Window).Children(func() {
			ui.Row(c).Fill().Center().Children(func() {
				octoLoader(c)
			})
		})
	}
	tester := frames(newTester(view, 120, 80))
	img := tester.Image()
	if tile := countColor(img, gwtheme.Light().Background); tile != 0 {
		t.Fatalf("the octopus carries no tile, %d background pixels", tile)
	}
	minX, minY, maxX, maxY := -1, -1, -1, -1
	ink := gwtheme.Light().Foreground
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			if ui.RGB(img.RGBAAt(x, y).R, img.RGBAAt(x, y).G, img.RGBAAt(x, y).B) != ink {
				continue
			}
			if minX < 0 || x < minX {
				minX = x
			}
			if maxX < x {
				maxX = x
			}
			if minY < 0 || y < minY {
				minY = y
			}
			if maxY < y {
				maxY = y
			}
		}
	}
	if minX < 0 {
		t.Fatal("the octopus must be drawn")
	}
	if center := float32(minX+maxX) / 2; center < 58 || center > 62 {
		t.Fatalf("the octopus sits centered horizontally, got center %v", center)
	}
	if center := float32(minY+maxY) / 2; center < 38 || center > 42 {
		t.Fatalf("the octopus sits centered vertically, got center %v", center)
	}
}

func TestTheMainAgentRowCentersItsContent(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	row, ok := tester.Find("main agent 会话")
	if !ok {
		t.Fatalf("the main agent row must be named, texts %q", tester.Texts())
	}
	octo, ok := tester.Find("章鱼")
	if !ok {
		t.Fatalf("the octopus must sit in the row, texts %q", tester.Texts())
	}
	text, ok := tester.Find("main agent 名称")
	if !ok {
		t.Fatalf("the row must name its agent, texts %q", tester.Texts())
	}
	groupCenter := (octo.X + text.X + text.W) / 2
	rowCenter := row.X + row.W/2
	if diff := groupCenter - rowCenter; diff < -2 || diff > 2 {
		t.Fatalf("the octopus and its name must center in the row, group %v row %v", groupCenter, rowCenter)
	}
	if margin := octo.X - row.X; margin < 16 {
		t.Fatalf("the octopus must keep its distance from the row's left edge, %v", margin)
	}
	if center := octo.Y + octo.H/2; center < row.Y+row.H/2-2 || center > row.Y+row.H/2+2 {
		t.Fatalf("the octopus centers vertically, center %v row %v", center, row.Y+row.H/2)
	}
}

func TestTheMainAgentOctopusAnimates(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	first := tester.Image()
	if ink := countColor(first, gwtheme.Light().Foreground); ink < 100 {
		t.Fatalf("the octopus must be drawn in theme ink, %d ink pixels", ink)
	}
	tester.Advance(150 * time.Millisecond)
	tester.Frame()
	second := tester.Image()
	if bytes.Equal(first.Pix, second.Pix) {
		t.Fatal("the octopus must move between frames")
	}
}
