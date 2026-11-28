package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// The card added end padding on top of the panel's, so it sat 12 from the left and 24 from the right.
func TestTheContextCardSitsEvenlyInsideItsPanel(t *testing.T) {
	shell := contextOverviewShell(t, contextOverviewSettings)
	shell.openModule("trajectory")
	tester := frames(newTester(shell.view, 1440, 900))
	panel, ok := tester.Find("当前上下文窗口")
	if !ok {
		t.Fatalf("the panel never rendered, texts %q", tester.Texts())
	}
	body, ok := tester.Find("上下文组成")
	if !ok {
		t.Fatalf("the card never rendered its bar, texts %q", tester.Texts())
	}
	left := body.X - panel.X
	right := (panel.X + panel.W) - (body.X + body.W)
	if gap := left - right; gap > 1 || gap < -1 {
		t.Fatalf("the card is off-centre in its panel: %.1f from the left, %.1f from the right", left, right)
	}
}

// The node card carried the same end padding.
func TestTheNodeContextCardSitsEvenlyInItsColumn(t *testing.T) {
	tester := frames(newTester(func(ctx *ui.Context) {
		ui.Box(ctx).FillWidth().Height(320).Padding(12).Children(func() {
			renderNodeContextCard(ctx, buildNodeContextCardData(nodeTrajectory(120_000, 200_000), "deepseek-v4", "研究员", 1_000_000))
		})
	}, 760, 320))
	bar, ok := tester.Find("上下文组成")
	if !ok {
		t.Fatalf("the node card never rendered its bar, texts %q", tester.Texts())
	}
	left := bar.X - 12
	right := (760 - 12) - (bar.X + bar.W)
	if gap := left - right; gap > 1 || gap < -1 {
		t.Fatalf("the node card is off-centre in its column: %.1f from the left, %.1f from the right", left, right)
	}
}
