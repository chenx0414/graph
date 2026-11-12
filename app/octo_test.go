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

func TestTheMainAgentOctopusAnimates(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
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
