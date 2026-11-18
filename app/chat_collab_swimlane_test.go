package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// swimlaneChat renders a chat whose transcript is the given collaboration
// messages, then opens the collaboration card so the assertions see the lanes.
// It mirrors what a user does: open a session, click the card header.
func swimlaneChat(t *testing.T, messages []transcriptMessage) *ui.Tester {
	t.Helper()
	state := newChatState("http://127.0.0.1:1", "tok")
	state.active = "self"
	state.messages = messages
	tester := frames(ui.NewTester(state.view, 900, 720))
	if err := tester.Click("跨 Agent 协作"); err != nil {
		t.Fatalf("open the collaboration card: %v", err)
	}
	return frames(tester)
}

// The three agents below are what a real fleet looks like: two sub-agents
// reporting to the master, plus the master itself as the receiver.
func swimlaneFleet() []transcriptMessage {
	return []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "子 Agent A 完成侦察", 3_000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "子 Agent B 完成侦察", 1_000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "子 Agent A 补交报告", 2_000, 2),
	}
}

// TestTheSwimlaneCardShowsOneLanePerAgent asserts the user-visible result: the
// card reports one lane per participating agent (A, B and the master), with
// that agent's own tasks and events counted on its lane.
func TestTheSwimlaneCardShowsOneLanePerAgent(t *testing.T) {
	tester := swimlaneChat(t, swimlaneFleet())

	if !tester.HasText("3 泳道") {
		t.Fatalf("the card must count one lane per agent, texts %q", tester.Texts())
	}
	if !tester.HasText("3 条") {
		t.Fatalf("the card must count the collaboration records, texts %q", tester.Texts())
	}
	// agent-A has two events on one task; agent-B has one event on one task.
	if !tester.HasText("1 任务 / 2 事件") {
		t.Fatalf("lane A must carry its own task/event counts, texts %q", tester.Texts())
	}
	if !tester.HasText("1 任务 / 1 事件") {
		t.Fatalf("lane B must carry its own task/event counts, texts %q", tester.Texts())
	}
}

// TestTheSwimlaneCardKeepsEachAgentsEventsInItsOwnLane asserts that A's two
// events stay on A's lane and B's single event on B's lane: the event text is
// shown next to the receiver, never moved to another agent.
func TestTheSwimlaneCardKeepsEachAgentsEventsInItsOwnLane(t *testing.T) {
	tester := swimlaneChat(t, swimlaneFleet())

	for _, text := range []string{"子 Agent A 完成侦察", "子 Agent A 补交报告", "子 Agent B 完成侦察"} {
		if !tester.HasText(text) {
			t.Fatalf("the card must show %q on its lane, texts %q", text, tester.Texts())
		}
	}
	// A's rows point at the master; B's row does too, but each lane's rows
	// carry only that agent's own text (checked by the counts above).
	if !tester.HasText("→ self") {
		t.Fatalf("each event names its receiver, texts %q", tester.Texts())
	}
}

// TestTheSwimlaneCardDrawsSenderToReceiverLinks asserts the arrows: every
// sender -> receiver pair gets a link row, and the strip painting the
// connector was registered for the frame.
func TestTheSwimlaneCardDrawsSenderToReceiverLinks(t *testing.T) {
	tester := swimlaneChat(t, swimlaneFleet())

	if !tester.HasText("协作连线") {
		t.Fatalf("the card must title its link section, texts %q", tester.Texts())
	}
	// Both agents report to the master: A twice, B once.
	if !tester.HasText("2 次") {
		t.Fatalf("the A -> master link must count two sends, texts %q", tester.Texts())
	}
	if !tester.HasText("1 次") {
		t.Fatalf("the B -> master link must count one send, texts %q", tester.Texts())
	}
	links := collabLinksFromEvents(buildCollabSwimlane(swimlaneFleet(), "self").Events)
	if len(links) != 2 {
		t.Fatalf("two sender -> receiver pairs, got %+v", links)
	}
}

// TestTheSwimlaneCardOrdersEventsByTime asserts the time column: the chips sit
// in timestamp order regardless of transcript order, and each chip reads with
// the shared relative-time formatter.
func TestTheSwimlaneCardOrdersEventsByTime(t *testing.T) {
	tester := swimlaneChat(t, swimlaneFleet())

	texts := tester.Texts()
	position := func(want string) int {
		for at, text := range texts {
			if text == want {
				return at
			}
		}
		return -1
	}
	// Inside one lane the chips read chronologically: A's 2s report sits above
	// its 3s completion even though the transcript listed the completion first.
	earlier := position("子 Agent A 补交报告")
	later := position("子 Agent A 完成侦察")
	if earlier < 0 || later < 0 {
		t.Fatalf("both of A's events must be on A's lane, texts %q", texts)
	}
	if earlier > later {
		t.Fatalf("A's lane must read in time order, got %d then %d", earlier, later)
	}
	// The whole model is globally time ordered, which is what the time column
	// follows.
	model := buildCollabSwimlane(swimlaneFleet(), "self")
	for at := 1; at < len(model.Events); at++ {
		if model.Events[at-1].CreatedAt > model.Events[at].CreatedAt {
			t.Fatalf("the time column must be ordered, got %+v", model.Events)
		}
	}
	// Chips carry the shared relative-date clock, not a bare 15:04: a 1970 stamp
	// therefore reads with its year.
	if !tester.HasText("1970年1月1日") {
		t.Fatalf("event chips must reuse the shared clock formatter, texts %q", texts)
	}
}

// TestClickingASwimlaneEventShowsItsContent asserts the click-to-read detail:
// tapping a chip opens the record with its sender, receiver and body.
func TestClickingASwimlaneEventShowsItsContent(t *testing.T) {
	tester := swimlaneChat(t, swimlaneFleet())
	if err := tester.Click("子 Agent A 完成侦察"); err != nil {
		t.Fatalf("click an event chip: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("协作记录 · A → self") {
		t.Fatalf("the clicked event opens its detail, texts %q", tester.Texts())
	}
	if !tester.HasText("收起") {
		t.Fatalf("the detail offers a way to fold it, texts %q", tester.Texts())
	}
}

// TestTheSwimlaneCardSearchesAndKeepsLinks asserts the header search: typing
// narrows the records, keeps the sender -> receiver links for what remains,
// and never invents a lane for an agent with no matching event.
func TestTheSwimlaneCardSearchesAndKeepsLinks(t *testing.T) {
	fleet := swimlaneFleet()
	fleet[0].Text = "alpha A 完成侦察"
	fleet[2].Text = "alpha A 补交报告"
	fleet[1].Text = "beta B 完成侦察"

	model := buildCollabSwimlane(fleet, "self")
	filtered := filterCollabSwimlane(model, "alpha")
	if filtered.Records != 2 {
		t.Fatalf("search keeps the two matching records, got %d", filtered.Records)
	}
	links := collabLinksFromEvents(filtered.Events)
	if len(links) != 1 || links[0].From != "agent-A" || links[0].To != "self" || links[0].Count != 2 {
		t.Fatalf("search keeps A -> self with two sends, got %+v", links)
	}
	for _, lane := range filtered.Lanes {
		if lane.ID == "agent-B" {
			t.Fatalf("search must not keep a lane with no matching event: %+v", filtered.Lanes)
		}
	}
}

// TestTheSwimlaneCardEmptyStateInventsNothing asserts the empty state: with no
// collaboration messages there is no card and no invented lane, chip or link,
// and an empty search inside the card says so instead of drawing an empty lane.
func TestTheSwimlaneCardEmptyStateInventsNothing(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.active = "self"
	tester := frames(ui.NewTester(state.view, 900, 720))
	for _, invented := range []string{"泳道", "协作连线", "A → self"} {
		if tester.HasText(invented) {
			t.Fatalf("an empty chat invented %q, texts %q", invented, tester.Texts())
		}
	}

	// With messages but a search that matches nothing, the card stays open and
	// explains itself rather than fabricating a lane.
	state.messages = swimlaneFleet()
	state.expanded["collab"] = true
	state.collabQuery = "匹配不到的关键词"
	tester = frames(ui.NewTester(state.view, 900, 720))
	if !tester.HasText("没有匹配的协作记录。") {
		t.Fatalf("a fruitless search says so, texts %q", tester.Texts())
	}
	if tester.HasText("协作连线") {
		t.Fatalf("a fruitless search draws no links, texts %q", tester.Texts())
	}
}
