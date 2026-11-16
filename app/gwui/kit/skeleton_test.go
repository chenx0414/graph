package kit_test

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/theme"
)

func TestSkeletonBarsAreLabeled(t *testing.T) {
	tester := ui.NewTesterWith(func(c *ui.Context) {
		theme.Apply(c, theme.Dark())
		ui.Column(c).Width(320).Gap(8).Children(func() {
			kit.SkeletonLine(c, 72, 10)
			kit.SkeletonBlock(c, 24, 24)
			kit.SkeletonCircle(c, 28)
		})
	}, 360, 160, ui.TesterOptions{Preferences: ui.Preferences{ReduceMotion: true}})
	tester.Frame()
	if _, ok := tester.Find(kit.SkeletonLabel); !ok {
		t.Fatalf("the loading placeholder is labeled, texts %q", tester.Texts())
	}
}

func TestTheSkeletonSweepKeepsRequestingFrames(t *testing.T) {
	tester := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c, theme.Dark())
		kit.SkeletonLine(c, 70, 10)
	}, 320, 80)
	tester.Frame()
	if !tester.FramePending() {
		t.Fatal("the skeleton sweep must keep asking for shimmer frames")
	}
}
