package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func paneProbeShell(t *testing.T, width, height int, kind string) (*shellState, *ui.Tester) {
	t.Helper()
	state := newShellState("http://127.0.0.1:1", "")
	if kind != "" {
		state.openModule(kind)
	}
	tester := frames(ui.NewTester(state.view, width, height))
	return state, tester
}

func panePages() []string {
	return []string{"", "providers", "capabilities", "assemblies", "settings", "resources", "models", "tasks", "questions", "fleet", "trajectory"}
}

func paneName(kind string) string {
	if kind == "" {
		return "whiteboard"
	}
	return kind
}

func dividerRight(t *testing.T, tester *ui.Tester) float32 {
	t.Helper()
	chatTitle, ok := tester.Find("对话标题")
	if !ok {
		t.Fatalf("the chat title never laid out, texts %q", tester.Texts())
	}
	return chatTitle.X + chatTitle.W
}

func TestTheDividerStaysPutAcrossPages(t *testing.T) {
	for _, size := range [][2]int{{1440, 900}, {1280, 800}, {1171, 700}} {
		reference := float32(-1)
		for _, kind := range panePages() {
			_, tester := paneProbeShell(t, size[0], size[1], kind)
			right := dividerRight(t, tester)
			if reference < 0 {
				reference = right
				continue
			}
			if delta := right - reference; delta < -0.5 || delta > 0.5 {
				t.Fatalf("%dx%d: %s moves the divider to %.1f, the first page puts it at %.1f", size[0], size[1], paneName(kind), right, reference)
			}
		}
	}
}

func TestTheWhiteboardTitleLinesUpWithTheCardsBelowIt(t *testing.T) {
	for _, size := range [][2]int{{1440, 900}, {1280, 800}, {1171, 700}} {
		for _, kind := range panePages() {
			state, tester := paneProbeShell(t, size[0], size[1], kind)
			tab, ok := tester.Find("标签页 " + state.board.pages[0].Title)
			if !ok {
				t.Fatalf("%dx%d %s: the first tab never laid out, texts %q", size[0], size[1], paneName(kind), tester.Texts())
			}
			page := state.boardPage()
			if len(page.Panels) == 0 {
				t.Fatalf("%dx%d %s: the page has no panels", size[0], size[1], kind)
			}
			rect, ok := state.board.rects[page.Panels[0].ID]
			if !ok {
				t.Fatalf("%dx%d %s: the first card never laid out, rects %+v", size[0], size[1], paneName(kind), state.board.rects)
			}
			if delta := tab.X - rect.X; delta < -1 || delta > 1 {
				t.Fatalf("%dx%d %s: the tab starts at %.1f but the cards start at %.1f", size[0], size[1], paneName(kind), tab.X, rect.X)
			}
		}
	}
}

func TestTheWindowFloorFitsTheLayout(t *testing.T) {
	width, height := windowFloorWidth(), windowFloorHeight()
	if width < 1024 || height < 640 {
		t.Fatalf("the floor may not undercut the old one: %dx%d", width, height)
	}
	for _, kind := range panePages() {
		state, tester := paneProbeShell(t, width, height, kind)
		card, ok := tester.Find("主区域卡片")
		if !ok {
			t.Fatalf("%s: the main card never laid out, texts %q", paneName(kind), tester.Texts())
		}
		tab, _ := tester.Find("标签页 " + state.board.pages[0].Title)
		if tab.X+tab.W > card.X+card.W+0.5 {
			t.Fatalf("%s: the whiteboard tab runs past the window at the floor: tab %+v card %+v", kind, tab, card)
		}
		page := state.boardPage()
		rect := state.board.rects[page.Panels[0].ID]
		if rect.X+rect.W > card.X+card.W+0.5 {
			t.Fatalf("%s: the cards run past the window at the floor: rect %+v card %+v", kind, rect, card)
		}
	}
}

func TestASingleCardPagePaintsTheWhiteboardBackdrop(t *testing.T) {
	colors := map[string][4]uint8{}
	for _, kind := range []string{"", "providers", "capabilities"} {
		state, tester := paneProbeShell(t, 1440, 900, kind)
		page := state.boardPage()
		rect := state.board.rects[page.Panels[0].ID]
		img := tester.Image()
		probe := img.RGBAAt(int(rect.X)-4, int(rect.Y)+int(rect.H/2))
		colors[kind] = [4]uint8{probe.R, probe.G, probe.B, probe.A}
	}
	for kind, color := range colors {
		if color != colors[""] {
			t.Fatalf("%s paints %v beside its card where the whiteboard paints %v", kind, color, colors["board"])
		}
	}
	if colors[""][0] >= 250 {
		t.Fatalf("the whiteboard backdrop is the deeper tone, got %v", colors[""])
	}
}

func TestTheWhiteboardFloorFitsEveryStandardPage(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "")
	var need float32
	view := func(ctx *ui.Context) {
		state.view(ctx)
		need = state.boardPageMinWidth(ctx) + boardCardChrome(ctx) + ctx.Theme().Space(2.5)*2
	}
	tester := frames(ui.NewTester(view, 1440, 900))
	for _, kind := range append(panePages(), "history", "overview", "conversation", "artifacts") {
		if kind != "" {
			state.openModule(kind)
			tester.Frame()
			tester.Frame()
		}
		if need > whiteboardFloorWidth {
			t.Fatalf("%s needs %.1f but the whiteboard may shrink to %.1f", paneName(kind), need, whiteboardFloorWidth)
		}
	}
}
