package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func contextTruthCard(data *conversationTrajectory, model string) *ui.Tester {
	shell := newShellState("http://127.0.0.1:1", "tok")
	shell.chat = newChatState("http://127.0.0.1:1", "tok")
	shell.chat.currentModel = model
	shell.modelMeta = map[string]modelMeta{
		model: {id: model, modelID: model, contextWindow: 1_000_000, maxTokens: 384_000},
	}
	shell.trajectory.data = data
	return frames(ui.NewTester(func(ctx *ui.Context) {
		ui.Box(ctx).FillWidth().Height(320).Children(func() {
			shell.panelContextOverview(ctx)
		})
	}, 760, 320))
}

func truthTrajectory(last, peak int64) *conversationTrajectory {
	return &conversationTrajectory{
		Totals: trajectoryTotals{Context: trajectoryContext{LastTokens: last, PeakTokens: peak}},
		Composition: trajectoryComposition{
			SystemPrompt: 4_000, ToolDefinitions: 8_000, UserMessages: 500,
			Injected: 1_500, AssistantReply: 40_000, ToolCalls: 6_000,
		},
	}
}

func textsJoined(tester *ui.Tester) string {
	return strings.Join(tester.Texts(), "\n")
}

func TestContextOverviewShowsTheRealOccupancyAndCompositionOnly(t *testing.T) {
	data := truthTrajectory(120_000, 900_000)
	tester := contextTruthCard(data, "deepseek/deepseek-v4.1-flash")
	texts := textsJoined(tester)
	for _, wanted := range []string{"120.0k", "1.0M tokens", "12.0%", "上下文已用",
		"系统提示词", "≈4.0k", "工具定义", "≈8.0k", "用户消息", "≈500",
		"注入内容", "≈1.5k", "助手消息", "≈40.0k", "工具结果", "≈6.0k"} {
		if !tester.HasText(wanted) {
			t.Fatalf("the card shows the real occupancy %q, texts %q", wanted, texts)
		}
	}
	for _, predicted := range []string{"900.0k", "估算", "预留", "预测"} {
		if tester.HasText(predicted) {
			t.Fatalf("the card predicts %q instead of measuring, texts %q", predicted, texts)
		}
	}
}

func TestContextOverviewBarHasNoHeadroomOrOutputReservation(t *testing.T) {
	segments := contextOverviewBarSegments(contextOverviewParts(truthTrajectory(120_000, 900_000).Composition), 120_000, 1_000_000)
	if len(segments) == 0 {
		t.Fatalf("the bar has no segments")
	}
	total := float32(0)
	for _, segment := range segments {
		total += segment.weight
		switch segment.kind {
		case "part", "unaccounted", "free":
		default:
			t.Fatalf("the bar carries a predicted segment %+v", segment)
		}
	}
	if total > 1.0001 || total < 0.9999 {
		t.Fatalf("the bar spans %.4f of the window, segments %+v", total, segments)
	}
}

func TestContextOverviewShowsAnEmptyStateWithoutRealOccupancy(t *testing.T) {
	tester := contextTruthCard(truthTrajectory(0, 0), "deepseek/deepseek-v4.1-flash")
	texts := textsJoined(tester)
	if !tester.HasText("暂无真实上下文数据") {
		t.Fatalf("the card invents an occupancy, texts %q", texts)
	}
	for _, invented := range []string{"上下文已用", "估算", "预留"} {
		if tester.HasText(invented) {
			t.Fatalf("the empty card shows %q, texts %q", invented, texts)
		}
	}
}

func TestContextOverviewStaysStableWhenOnlyThePeakChanges(t *testing.T) {
	data := truthTrajectory(120_000, 120_000)
	tester := contextTruthCard(data, "deepseek/deepseek-v4.1-flash")
	before := textsJoined(tester)
	data.Totals.Context.PeakTokens = 980_000
	data.Composition.AssistantReply = 41_000
	tester.Frame()
	after := textsJoined(tester)
	if strings.Contains(after, "980.0k") {
		t.Fatalf("the card followed the peak, texts %q", after)
	}
	if before == after {
		return
	}
	if !strings.Contains(after, "≈41.0k") {
		t.Fatalf("the card ignored the real composition change, before %q after %q", before, after)
	}
}

// TestTheContextBarPaintsItsSegmentsInOneRow pins the shape the card shows: the
// composition is a single bar that spans the window once, not one full width band
// per segment. The check reads the painted row, so a bar whose segments each fill
// the whole width fails no matter how the numbers are formatted.
func TestTheContextBarPaintsItsSegmentsInOneRow(t *testing.T) {
	tester := contextTruthCard(truthTrajectory(120_000, 900_000), "deepseek/deepseek-v4.1-flash")
	bar, ok := tester.Find("上下文组成")
	if !ok {
		t.Fatalf("the context card paints one labeled bar, texts %q", tester.Texts())
	}
	if bar.H > 24 {
		t.Fatalf("the bar must be one thin row, got height %.1f", bar.H)
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
		t.Fatalf("the bar shows %d color bands across %d px; the segments must sit side by side", runs, width)
	}
	if longest >= width {
		t.Fatalf("one band fills the whole bar (%d of %d px); segments must share the width", longest, width)
	}
}

func colorDistance(a, b int) int {
	ar, ag, ab := a>>16&0xff, a>>8&0xff, a&0xff
	br, bg, bb := b>>16&0xff, b>>8&0xff, b&0xff
	distance := 0
	for _, pair := range [][2]int{{ar, br}, {ag, bg}, {ab, bb}} {
		if pair[0] > pair[1] {
			distance += pair[0] - pair[1]
		} else {
			distance += pair[1] - pair[0]
		}
	}
	return distance
}
