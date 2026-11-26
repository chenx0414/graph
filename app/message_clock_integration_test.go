package main

import (
	"testing"
	"time"
)

// TestMessageClockRendersRelativeDates is the user-visible half of wish 5 for
// chat messages: the timestamp under an assistant or user bubble must carry a
// date for anything that is not today. A date from 2001 is chosen so the label
// is stable whatever day the suite runs on — no sleep, no wall-clock guess.
func TestMessageClockRendersRelativeDates(t *testing.T) {
	old := time.Date(2001, time.March, 14, 15, 4, 0, 0, time.Local).UnixMilli()
	if got, want := messageClock(old), "2001年3月14日 15:04"; got != want {
		t.Fatalf("messageClock(old) = %q, want %q — the bubble must show a date, not a bare time", got, want)
	}
	if got := messageClock(0); got != "" {
		t.Fatalf("messageClock(0) = %q, want empty — missing data must not invent a date", got)
	}
}

// TestMessageBubblesShowRelativeDate checks the same result where the user
// actually sees it: a bubble from an older day renders a dated label, while a
// message without a timestamp shows none.
func TestMessageBubblesShowRelativeDate(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	old := time.Date(2001, time.March, 14, 15, 4, 0, 0, time.Local).UnixMilli()
	state.messages = []transcriptMessage{
		{Role: "assistant", Text: "一句回答", CreatedAt: old},
		{Role: "user", Text: "一句提问", CreatedAt: old},
	}
	tester := frames(newTester(state.view, 760, 620))
	if !tester.HasText("2001年3月14日 15:04") {
		t.Fatalf("message bubbles must show a dated timestamp, texts %q", tester.Texts())
	}

	state.messages = []transcriptMessage{
		{Role: "assistant", Text: "没有时间的回答", CreatedAt: 0},
	}
	tester = frames(newTester(state.view, 760, 620))
	for _, text := range tester.Texts() {
		if text == "00:00" || text == "08:00" {
			t.Fatalf("a bubble without a timestamp must not invent one, texts %q", tester.Texts())
		}
	}
}
