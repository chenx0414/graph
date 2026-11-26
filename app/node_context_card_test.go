package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// nodeContextTruthCard renders one Agent(node)'s own context card from an
// explicit trajectory so the test asserts what a user sees in a node session.
func nodeContextTruthCard(data *conversationTrajectory, model, agentName string, window int64) *ui.Tester {
	view := buildNodeContextCardData(data, model, agentName, window)
	return frames(newTester(func(ctx *ui.Context) {
		ui.Box(ctx).FillWidth().Height(320).Children(func() {
			renderNodeContextCard(ctx, view)
		})
	}, 760, 320))
}

func nodeTrajectory(last, peak int64) *conversationTrajectory {
	return &conversationTrajectory{
		TaskId: "task-1",
		Totals: trajectoryTotals{Context: trajectoryContext{LastTokens: last, PeakTokens: peak}},
		Agents: []trajectoryAgent{{TaskId: "task-1", NodeId: "node-7", Role: "研究员", Model: "deepseek/deepseek-v4.1-flash", Requests: 3}},
		// A real node trajectory carries request snapshots, so the card reports
		// the composition scaled onto the measured occupancy (legend sums to
		// the 120.0k it shows), exactly like the main context card.
		Requests: []trajectoryRequest{{Model: "deepseek/deepseek-v4.1-flash", ContextTokens: last}},
		Composition: trajectoryComposition{
			SystemPrompt: 4_000, ToolDefinitions: 8_000, UserMessages: 500,
			Injected: 1_500, AssistantReply: 40_000, ToolCalls: 6_000,
		},
	}
}

func TestNodeContextCardShowsTheNodesOwnOccupancyAndComposition(t *testing.T) {
	data := nodeTrajectory(120_000, 900_000)
	tester := nodeContextTruthCard(data, "deepseek/deepseek-v4.1-flash", "研究员", 1_000_000)
	texts := textsJoined(tester)
	// The composition legend is scaled onto the measured 120.0k occupancy
	// (the raw 60k snapshot doubles), so its parts add up to the occupancy the
	// card reports — the same 口径 as the main context card.
	for _, wanted := range []string{"研究员", "12.0%", "上下文已用", "120.0k", "1.0M tokens",
		"系统提示词", "≈8.0k", "工具定义", "≈16.0k", "用户消息", "≈1.0k",
		"注入内容", "≈3.0k", "助手消息", "≈80.0k", "工具结果", "≈12.0k"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the node card does not show %q, texts %q", wanted, texts)
		}
	}
	// The card reports measured occupancy, never the peak or an estimate.
	for _, invented := range []string{"900.0k", "估算", "预留", "预测"} {
		if tester.HasText(invented) {
			t.Fatalf("the node card invents %q, texts %q", invented, texts)
		}
	}
}

func TestNodeContextCardShowsAnEmptyStateWithoutRealOccupancy(t *testing.T) {
	tester := nodeContextTruthCard(nodeTrajectory(0, 0), "deepseek/deepseek-v4.1-flash", "研究员", 1_000_000)
	texts := textsJoined(tester)
	if !tester.HasText("暂无真实上下文数据") {
		t.Fatalf("the empty node card has no empty state, texts %q", texts)
	}
	for _, invented := range []string{"上下文已用", "估算", "预留"} {
		if tester.HasText(invented) {
			t.Fatalf("the empty node card shows %q, texts %q", invented, texts)
		}
	}
}

func TestNodeContextCardReadsOnlyTheGivenTrajectory(t *testing.T) {
	// The node card must be a pure function of the node's own trajectory:
	// the model/name passed in must be the one shown, never the main session's
	// active chat model.
	tester := nodeContextTruthCard(nodeTrajectory(50_000, 0), "model/node-only", "节点A", 200_000)
	texts := textsJoined(tester)
	if !tester.HasText("节点A") {
		t.Fatalf("the node card did not use the given agent name, texts %q", texts)
	}
	if strings.Contains(texts, "研究员") || strings.Contains(texts, "deepseek") {
		t.Fatalf("the node card leaked the trajectory's own model/name instead of the caller's, texts %q", texts)
	}
}

func TestNodeContextCardStaysStableWhenOnlyThePeakChanges(t *testing.T) {
	data := nodeTrajectory(120_000, 120_000)
	tester := nodeContextTruthCard(data, "deepseek/deepseek-v4.1-flash", "研究员", 1_000_000)
	before := textsJoined(tester)
	data.Totals.Context.PeakTokens = 980_000
	tester.Frame()
	after := textsJoined(tester)
	if strings.Contains(after, "980.0k") {
		t.Fatalf("the node card followed the peak, texts %q", after)
	}
	if before != after {
		t.Fatalf("the node card changed when only the peak changed, before %q after %q", before, after)
	}
}

func TestNodeContextCardBarIsOneProportionalRow(t *testing.T) {
	tester := nodeContextTruthCard(nodeTrajectory(120_000, 900_000), "deepseek/deepseek-v4.1-flash", "研究员", 1_000_000)
	bar, ok := tester.Find("上下文组成")
	if !ok {
		t.Fatalf("the node card paints one labeled bar, texts %q", tester.Texts())
	}
	if bar.H > 24 {
		t.Fatalf("the node bar must be one thin row, got height %.1f", bar.H)
	}
	img := tester.Image()
	y := int(bar.Y + bar.H/2)
	runs, longest, length := 0, 0, 0
	previous := -1
	for x := int(bar.X) + 1; x < int(bar.X+bar.W)-1; x++ {
		at := img.PixOffset(x, y)
		color := int(img.Pix[at])<<16 | int(img.Pix[at+1])<<8 | int(img.Pix[at+2])
		if previous < 0 || colorDistance(previous, color) > 12 {
			runs++
			length = 1
			previous = color
		} else {
			length++
		}
		if length > longest {
			longest = length
		}
	}
	width := int(bar.W) - 2
	if runs < 3 {
		t.Fatalf("the node bar shows %d color bands across %d px; segments must sit side by side", runs, width)
	}
	if longest >= width {
		t.Fatalf("one band fills the whole node bar (%d of %d px)", longest, width)
	}
}
