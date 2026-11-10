package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

func settle(tester *ui.Tester) *ui.Tester {
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	return tester
}

func TestListRowsRenderEveryRowAfterAFrame(t *testing.T) {
	state := &ui.ListState{FollowEnd: true}
	state.FollowAnimation = &ui.Smooth
	labels := []string{"甲", "乙", "丙"}
	view := func(c *ui.Context) {
		ui.Column(c).Fill().Children(func() {
			ui.List(c, state, len(labels), func(index int) { ui.Text(c, labels[index]) }).Grow(1)
		})
	}
	texts := settle(ui.NewTester(view, 600, 400)).Texts()
	for _, label := range labels {
		if !contains(texts[0]+contains3(texts), label) {
			t.Fatalf("row %q missing, texts %q", label, texts)
		}
	}
}

func TestListRowsMayBeBuiltWithARowOrAColumn(t *testing.T) {
	for _, asRow := range []bool{true, false} {
		state := &ui.ListState{}
		labels := []string{"甲", "乙"}
		row := func(index int) func(*ui.Context) {
			if asRow {
				return func(c *ui.Context) {
					ui.Row(c).Gap(4).Children(func() {
						ui.Text(c, labels[index])
						ui.Text(c, "尾巴")
					})
				}
			}
			return func(c *ui.Context) {
				ui.Column(c).Children(func() { ui.Text(c, labels[index]) })
			}
		}
		view := func(c *ui.Context) {
			ui.Column(c).Fill().Children(func() {
				ui.List(c, state, len(labels), func(index int) { row(index)(c) }).Grow(1)
			})
		}
		texts := settle(ui.NewTester(view, 600, 400)).Texts()
		joined := ""
		for _, text := range texts {
			joined += text
		}
		for _, label := range labels {
			if !contains(joined, label) {
				t.Fatalf("asRow=%v: row %q missing, texts %q", asRow, label, texts)
			}
		}
	}
}

func TestStreamingMarkdownWaitsForTheRevealClock(t *testing.T) {
	options := markdown.Options{}
	source := "## 标题\n\n**结论。**后文"
	view := func(c *ui.Context) { markdown.Stream(c, source, &options) }

	tester := ui.NewTester(view, 600, 300)
	immediately := tester.Texts()
	tester.Advance(2 * time.Second)
	revealed := tester.Texts()
	joined := ""
	for _, text := range revealed {
		joined += text
	}
	if !contains(joined, "结论。后文") {
		t.Fatalf("the reveal did not land after the clock advanced: immediately=%q later=%q", immediately, revealed)
	}
}

func contains3(texts []string) string {
	joined := ""
	for _, text := range texts {
		joined += text
	}
	return joined
}
