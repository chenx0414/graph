package main

import (
	"fmt"
	"testing"

	"github.com/egoist/mygo/ui"
)

func edgeInsetCard(t *testing.T) (*shellState, *ui.Tester, *edgeScroll) {
	t.Helper()
	state, tester := fadeInsetTester(t)
	scroll := state.board.scrolls["history"]
	if scroll == nil || scroll.MaxY < 200 {
		t.Fatalf("the history card must scroll, scroll %+v", scroll)
	}
	return state, tester, scroll
}

func TestACardAtItsTopClearsTheFadeAndDropsTheBand(t *testing.T) {
	_, tester, scroll := edgeInsetCard(t)
	card := fadeCard(t, tester)
	row, ok := tester.Find("历史行 00")
	if !ok {
		t.Fatalf("the history rows never rendered, texts %q", tester.Texts())
	}
	if gap := row.Y - card.Y; gap < boardPanelPadding+fadeEdgeClearance-1 {
		t.Fatalf("a card resting at its top clears the fade by %.1f, got %.1f: card %+v row %+v", fadeEdgeClearance, gap, card, row)
	}
	if band := scroll.mask().Stops[1].At; band != 0 {
		t.Fatalf("a card resting at its top keeps no fade band there, got %.2f", band)
	}
}

func TestACardAtItsEndClearsTheFadeAndDropsTheBand(t *testing.T) {
	_, tester, scroll := edgeInsetCard(t)
	card := fadeCard(t, tester)
	scroll.Y = 1e9
	tester = frames(tester)
	row, ok := tester.Find("历史行 39")
	if !ok || row.H <= 0 {
		t.Fatalf("the last row never rendered at the end, %+v texts %q", row, tester.Texts())
	}
	if gap := card.Y + card.H - (row.Y + row.H); gap < boardPanelPadding+fadeEdgeClearance-1 {
		t.Fatalf("a card resting at its end clears the fade by %.1f, got %.1f: card %+v row %+v", fadeEdgeClearance, gap, card, row)
	}
	if band := scroll.mask().Stops[2].At; band != 1 {
		t.Fatalf("a card resting at its end keeps no fade band there, got %.2f", band)
	}
}

func TestACardScrolledBetweenBothEndsKeepsBothBands(t *testing.T) {
	_, tester, scroll := edgeInsetCard(t)
	scroll.Y = scroll.MaxY / 2
	tester = frames(tester)
	gradient := scroll.mask()
	if gradient.Stops[1].At != fadeBand || gradient.Stops[2].At != 1-fadeBand {
		t.Fatalf("a card scrolled between both ends fades both: top %.2f bottom %.2f", gradient.Stops[1].At, gradient.Stops[2].At)
	}
	card := fadeCard(t, tester)
	row, ok := tester.Find("历史行 00")
	if ok && row.Y-row.H < card.Y {
		t.Fatalf("a scrolled card keeps its padding off the resting edges: row %+v card %+v", row, card)
	}
}

func TestTheChatTranscriptClearsTheFadeAtItsEnd(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	chat := state.chat
	if !chat.list.AtEnd() {
		t.Fatalf("a chat transcript follows its end, at end %v", chat.list.AtEnd())
	}
	if band := chat.track.mask().Stops[2].At; band != 1 {
		t.Fatalf("a transcript resting at its end keeps no fade band there, got %.2f", band)
	}
	last, ok := tester.Find(fmt.Sprintf("历史消息 %02d", 59))
	if !ok {
		t.Fatalf("the newest message never rendered, texts %q", tester.Texts())
	}
	if last.Y+last.H > 900 {
		t.Fatalf("the newest message sits outside the window, got %+v", last)
	}
}

func TestTheConversationListClearsTheFadeAtItsTop(t *testing.T) {
	state := fourPaneShell(t)
	state.conversations = nil
	for index := 0; index < 40; index++ {
		state.conversations = append(state.conversations, conversationSummary{
			ID: fmt.Sprintf("c%02d", index), Title: fmt.Sprintf("会话行 %02d", index),
		})
	}
	tester := frames(newTester(state.view, 1440, 900))
	if band := state.listScroll.mask().Stops[1].At; band != 0 {
		t.Fatalf("a list resting at its top keeps no fade band there, got %.2f", band)
	}
	row, ok := tester.Find("会话行 00")
	if !ok {
		t.Fatalf("the first conversation never rendered, texts %q", tester.Texts())
	}
	if row.Y < titleBandHeight(&ui.Context{}) {
		t.Fatalf("the first row is clipped above the list, got %+v", row)
	}
}

func TestTheChatTranscriptClearsTheFadeWhenScrolledToItsTop(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	chat := state.chat
	chat.track.Y = 0
	chat.track.X = 0
	tester = frames(tester)
	tester = frames(tester)
	if band := chat.track.mask().Stops[1].At; band != 0 {
		t.Fatalf("a transcript scrolled to its top keeps no fade band there, got %.2f (y %.1f)", band, chat.track.Y)
	}
	first, ok := tester.Find("历史消息 00")
	if !ok {
		t.Skip("the oldest row is out of view at this window size")
	}
	if first.Y < 0 {
		t.Fatalf("the oldest row sits above the transcript, got %.1f", first.Y)
	}
}

func TestTheWhiteboardCanvasClearsTheFadeOnTheEdgeItRestsOn(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "")
	tester := frames(newTester(state.view, 1440, 500))
	canvas := &state.board.viewportScroll
	if canvas.MaxY <= 0 {
		t.Fatalf("the whiteboard must scroll at this height, maxY %0.1f", canvas.MaxY)
	}
	page := state.boardPage()
	viewport := state.board.viewport
	top := state.board.rects[page.Panels[0].ID]
	if top.Y < viewport.Y {
		t.Fatalf("the first card sits above the canvas at rest: card %+v viewport %+v", top, viewport)
	}
	if band := canvas.mask().Stops[1].At; band != 0 {
		t.Fatalf("a canvas resting at its top keeps no fade band there, got %.2f", band)
	}
	canvas.Y = 1e9
	tester = frames(tester)
	last := state.board.rects[page.Panels[len(page.Panels)-1].ID]
	if last.Y+last.H > viewport.Y+viewport.H {
		t.Fatalf("the last card sits below the canvas at its end: card %+v viewport %+v", last, viewport)
	}
	if band := canvas.mask().Stops[2].At; band != 1 {
		t.Fatalf("a canvas resting at its end keeps no fade band there, got %.2f", band)
	}
	canvas.Y = canvas.MaxY / 2
	tester = frames(tester)
	gradient := canvas.mask().Stops
	if gradient[1].At != fadeBand || gradient[2].At != 1-fadeBand {
		t.Fatalf("a canvas scrolled between both ends fades both: top %.2f bottom %.2f", gradient[1].At, gradient[2].At)
	}
}

func TestACardRestingAtItsEndKeepsOneSteadyPlace(t *testing.T) {
	_, tester, scroll := edgeInsetCard(t)
	scroll.Y = 1e9
	tester = frames(tester)
	settled := scroll.MaxY
	for frame := 0; frame < 6; frame++ {
		render(tester)
		if scroll.MaxY != settled {
			t.Fatalf("a card resting at its end reflows on frame %d: maxY %.2f against %.2f", frame, scroll.MaxY, settled)
		}
		if band := scroll.mask().Stops[2].At; band != 1 {
			t.Fatalf("a card resting at its end loses its clearance on frame %d: bottom band %.2f", frame, band)
		}
	}
}

func TestTheConversationListRestingAtItsTopKeepsOneSteadyPlace(t *testing.T) {
	state := fourPaneShell(t)
	state.conversations = nil
	for index := 0; index < 40; index++ {
		state.conversations = append(state.conversations, conversationSummary{
			ID: fmt.Sprintf("c%02d", index), Title: fmt.Sprintf("会话行 %02d", index),
		})
	}
	tester := frames(newTester(state.view, 1440, 900))
	settled := state.listScroll.MaxY
	for frame := 0; frame < 6; frame++ {
		render(tester)
		if state.listScroll.MaxY != settled {
			t.Fatalf("a list resting at its top reflows on frame %d: maxY %.2f against %.2f", frame, state.listScroll.MaxY, settled)
		}
	}
}

func TestTheChatTranscriptRestingAtItsEndKeepsOneSteadyPlace(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	chat := state.chat
	settled := chat.track.MaxY
	for frame := 0; frame < 6; frame++ {
		render(tester)
		if chat.track.MaxY != settled {
			t.Fatalf("a transcript following its end reflows on frame %d: maxY %.2f against %.2f", frame, chat.track.MaxY, settled)
		}
		if band := chat.track.mask().Stops[2].At; band != 1 {
			t.Fatalf("a transcript following its end loses its clearance on frame %d: bottom band %.2f", frame, band)
		}
	}
}

func TestANearEdgeScrollSettlesInsteadOfFlappingEveryFrame(t *testing.T) {
	for _, offset := range []float32{1, 2, 6} {
		_, tester, scroll := edgeInsetCard(t)
		scroll.Y = scroll.MaxY - offset
		seen := map[[2]float32]int{}
		for frame := 0; frame < 8; frame++ {
			render(tester)
			top, bottom := scroll.insets()
			seen[[2]float32{top, bottom}]++
			if len(seen) > 1 {
				t.Fatalf("%0.0f px from the end, the clearance flips between %v by frame %d", offset, seen, frame)
			}
		}
		if seen[[2]float32{0, fadeEdgeClearance}] != 8 {
			t.Fatalf("%0.0f px from the end, the clearance never settled: %v", offset, seen)
		}
	}
}

func TestShortContentKeepsItsEdgeClearance(t *testing.T) {
	state := fourPaneShell(t)
	state.conversations = []conversationSummary{{ID: "c1", Title: "唯一会话"}}
	chat := state.chat
	chat.messages = []transcriptMessage{{ID: "m1", Seq: 1, Role: "assistant", Kind: "chat",
		Text: "短消息", State: "done", CreatedAt: 1700000000000}}
	chat.status = ""
	chat.loading = false
	tester := frames(newTester(state.view, 1440, 900))
	for name, scroll := range map[string]*edgeScroll{
		"the chat transcript":   &chat.track,
		"the conversation list": &state.listScroll,
		"the whiteboard canvas": &state.board.viewportScroll,
	} {
		if scroll.MaxY != 0 {
			t.Fatalf("%s has nothing to scroll, maxY %0.1f", name, scroll.MaxY)
		}
		if scroll.MaxY != 0 {
			t.Fatalf("%s gains a scroll range from its own clearance, maxY %0.1f", name, scroll.MaxY)
		}
		if top, bottom := scroll.insets(); top != fadeEdgeClearance || bottom != fadeEdgeClearance {
			t.Fatalf("%s holds content that fits: both edges keep their clearance, got (%0.1f, %0.1f)", name, top, bottom)
		}
		gradient := scroll.mask()
		if gradient.Stops[1].At != 0 || gradient.Stops[2].At != 1 {
			t.Fatalf("%s fades content that cannot scroll: top %0.2f bottom %0.2f", name, gradient.Stops[1].At, gradient.Stops[2].At)
		}
	}
	message, ok := tester.Find("短消息")
	if !ok || message.H <= 0 {
		t.Fatalf("the one message sits on screen, got %+v texts %q", message, tester.Texts())
	}
	band, _ := tester.Find("对话标题")
	if gap := message.Y - (band.Y + band.H); gap < fadeEdgeClearance-1 {
		t.Fatalf("the one message keeps clear of the title band by %.1f, want %.1f: message %+v band %+v", gap, fadeEdgeClearance, message, band)
	}
	row, ok := tester.Find("唯一会话")
	if !ok || row.Y <= 0 || row.H <= 0 {
		t.Fatalf("the one conversation sits on screen, got %+v texts %q", row, tester.Texts())
	}
}

func TestACardWhoseRowsFitKeepsItsEdgeClearance(t *testing.T) {
	for _, rows := range []int{1, 2} {
		state := fourPaneShell(t)
		state.conversations = nil
		for index := 0; index < rows; index++ {
			state.conversations = append(state.conversations, conversationSummary{
				ID: fmt.Sprintf("c%02d", index), Title: fmt.Sprintf("历史行 %02d", index),
			})
		}
		panel := boardPanel{ID: "history", Kind: "history"}
		var scroll *edgeScroll
		view := func(ctx *ui.Context) {
			ui.Column(ctx).Fill().Padding(60).Children(func() {
				card := ui.Column(ctx).FillWidth().Height(400).Label(boardPanelTitle("history") + "窗口")
				card.Children(func() {
					state.boardPanelView(ctx, &panel, false, boardHeaderNone)
				})
			})
			scroll = state.board.scrolls["history"]
		}
		tester := frames(newTester(view, 1440, 900))
		if scroll == nil || scroll.MaxY != 0 {
			t.Fatalf("%d rows fit the card, maxY %0.1f", rows, scroll.MaxY)
		}
		if top, bottom := scroll.insets(); top != fadeEdgeClearance || bottom != fadeEdgeClearance {
			t.Fatalf("%d rows fit the card: both edges keep their clearance, got (%0.1f, %0.1f)", rows, top, bottom)
		}
		row, ok := tester.Find("历史行 00")
		if !ok {
			t.Fatalf("%d rows: the first row never rendered, texts %q", rows, tester.Texts())
		}
		card, _ := tester.Find(boardPanelTitle("history") + "窗口")
		if gap := row.Y - card.Y; gap < boardPanelPadding+fadeEdgeClearance-1 || gap > boardPanelPadding+fadeEdgeClearance+1 {
			t.Fatalf("%d rows: the first row keeps the card's padding plus the edge clearance, got %.1f: card %+v row %+v", rows, gap, card, row)
		}
	}
}

func TestAnEmptyTranscriptHoldsNoScrollableEdges(t *testing.T) {
	state := fourPaneShell(t)
	chat := state.chat
	chat.messages = nil
	chat.status = ""
	chat.loading = false
	tester := frames(newTester(state.view, 1440, 900))
	if top, bottom := chat.track.insets(); top != fadeEdgeClearance || bottom != fadeEdgeClearance {
		t.Fatalf("an empty transcript has nothing to scroll: both edges keep their clearance, got (%0.1f, %0.1f)", top, bottom)
	}
	if band := chat.track.mask(); band.Stops[1].At != 0 || band.Stops[2].At != 1 {
		t.Fatalf("an empty transcript fades nothing: top %0.2f bottom %0.2f", band.Stops[1].At, band.Stops[2].At)
	}
	if !tester.HasText("还没有对话") {
		t.Fatalf("an empty transcript says so, texts %q", tester.Texts())
	}
}

func TestContentJustUnderOnePageSettlesInsteadOfPopingAScrollbar(t *testing.T) {
	for _, messages := range []int{1, 10, 12, 13, 14, 20} {
		state := fourPaneShell(t)
		chat := state.chat
		chat.messages = nil
		for index := 0; index < messages; index++ {
			chat.messages = append(chat.messages, transcriptMessage{
				ID: fmt.Sprintf("m%02d", index), Seq: int64(index + 1), Role: "assistant", Kind: "chat",
				Text: fmt.Sprintf("消息 %02d", index), State: "done", CreatedAt: 1700000000000,
			})
		}
		chat.status = ""
		chat.loading = false
		tester := frames(newTester(state.view, 1440, 900))
		settled := chat.track.MaxY
		top, bottom := chat.track.insets()
		for frame := 0; frame < 8; frame++ {
			render(tester)
			if chat.track.MaxY != settled {
				t.Fatalf("%d messages: the transcript reflows on frame %d, maxY %.1f against %.1f", messages, frame, chat.track.MaxY, settled)
			}
			if gotTop, gotBottom := chat.track.insets(); gotTop != top || gotBottom != bottom {
				t.Fatalf("%d messages: the clearance flips on frame %d, (%0.1f, %0.1f) against (%0.1f, %0.1f)", messages, frame, gotTop, gotBottom, top, bottom)
			}
		}
	}
}

func TestContentThatFillsThePageKeepsTheClearanceThatFits(t *testing.T) {
	for _, messages := range []int{12, 13, 14} {
		state := fourPaneShell(t)
		chat := state.chat
		chat.messages = nil
		for index := 0; index < messages; index++ {
			chat.messages = append(chat.messages, transcriptMessage{
				ID: fmt.Sprintf("m%02d", index), Seq: int64(index + 1), Role: "assistant", Kind: "chat",
				Text: fmt.Sprintf("消息 %02d", index), State: "done", CreatedAt: 1700000000000,
			})
		}
		chat.status = ""
		chat.loading = false
		tester := frames(newTester(state.view, 1440, 900))
		render(tester)
		top, bottom := chat.track.insets()
		if chat.track.MaxY == 0 && (top != fadeEdgeClearance || bottom != fadeEdgeClearance) {
			t.Fatalf("%d messages fit the page: both edges keep their clearance, got (%0.1f, %0.1f)", messages, top, bottom)
		}
		if top > fadeEdgeClearance || bottom > fadeEdgeClearance {
			t.Fatalf("%d messages ask for more clearance than the page allows: (%0.1f, %0.1f)", messages, top, bottom)
		}
	}
}
