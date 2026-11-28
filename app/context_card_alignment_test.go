package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// The card sits inside the board panel, which pads its body by the same amount
// on every side. The card added its own end padding on top of that, so its
// content sat 12 from the left edge and 24 from the right: the block was not
// centred in the panel and its right corner was pushed against a rounded one.
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

// A node session draws the same card in the same column. The extra end padding
// pushed its content 12 further from the right edge than from the left.
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
