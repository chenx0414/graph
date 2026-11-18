package main

import (
	"reflect"
	"testing"
)

func swimlaneMessage(id, from, to, task, text string, created int64, seq int64) transcriptMessage {
	m := transcriptMessage{
		ID: id, Seq: seq, Role: "assistant", Kind: "chat", Text: text,
		CreatedAt: created,
	}
	m.Data.Source.Kind = "agent"
	m.Data.Source.ConversationID = from
	m.Data.Source.TaskID = task
	if to != "" {
		m.Data.Source.Summary = "→ " + to
	}
	return m
}

func TestSwimlaneLanesAreTheParticipatingAgents(t *testing.T) {
	messages := []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "A to master", 3000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "B to master", 1000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "A again", 2000, 2),
	}
	model := buildCollabSwimlane(messages, "self")

	ids := make([]string, 0, len(model.Lanes))
	for _, lane := range model.Lanes {
		ids = append(ids, lane.ID)
	}
	want := []string{"agent-A", "agent-B", "self"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("lane ids = %q, want %q", ids, want)
	}
	if model.LaneCount() != len(want) {
		t.Fatalf("lane count = %d, want %d", model.LaneCount(), len(want))
	}
}

func TestSwimlaneEventsAreTimeOrderedAndStayInTheirLane(t *testing.T) {
	messages := []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "A to master", 3000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "B to master", 1000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "A again", 2000, 2),
	}
	model := buildCollabSwimlane(messages, "self")

	got := make([]string, 0, len(model.Events))
	for _, event := range model.Events {
		got = append(got, event.ID)
	}
	want := []string{"m2", "m3", "m1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("event order = %q, want %q", got, want)
	}
	for _, event := range model.Events {
		switch event.ID {
		case "m1", "m3":
			if event.LaneID != "agent-A" {
				t.Fatalf("event %s lane = %q, want agent-A", event.ID, event.LaneID)
			}
		case "m2":
			if event.LaneID != "agent-B" {
				t.Fatalf("event %s lane = %q, want agent-B", event.ID, event.LaneID)
			}
		}
		if event.From == "" || event.To == "" {
			t.Fatalf("event %s missing sender or receiver: %+v", event.ID, event)
		}
	}
}

func TestSwimlaneDrawsSenderToReceiverLinks(t *testing.T) {
	messages := []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "A to master", 3000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "B to master", 1000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "A again", 2000, 2),
	}
	model := buildCollabSwimlane(messages, "self")

	want := map[string]int{"agent-A>self": 2, "agent-B>self": 1}
	if len(model.Links) != len(want) {
		t.Fatalf("links = %+v, want %d pairs", model.Links, len(want))
	}
	for _, link := range model.Links {
		key := link.From + ">" + link.To
		if link.Count != want[key] {
			t.Fatalf("link %s count = %d, want %d", key, link.Count, want[key])
		}
	}
}

func TestSwimlaneHeaderStatsAndPerLaneCounts(t *testing.T) {
	messages := []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "A to master", 3000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "B to master", 1000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "A again", 2000, 2),
	}
	model := buildCollabSwimlane(messages, "self")

	if model.Records != 3 {
		t.Fatalf("records = %d, want 3", model.Records)
	}
	if model.Earliest != 1000 || model.Latest != 3000 {
		t.Fatalf("earliest/latest = %d/%d, want 1000/3000", model.Earliest, model.Latest)
	}
	byID := map[string]collabSwimlaneLane{}
	for _, lane := range model.Lanes {
		byID[lane.ID] = lane
	}
	if byID["agent-A"].Events != 2 || byID["agent-A"].Tasks != 1 {
		t.Fatalf("lane agent-A = %+v, want events 2 tasks 1", byID["agent-A"])
	}
	if byID["agent-B"].Events != 1 || byID["agent-B"].Tasks != 1 {
		t.Fatalf("lane agent-B = %+v, want events 1 tasks 1", byID["agent-B"])
	}
}

func TestSwimlaneEmptyStateHasNoInventedData(t *testing.T) {
	model := buildCollabSwimlane(nil, "self")

	if model.Records != 0 || model.Earliest != 0 || model.Latest != 0 {
		t.Fatalf("empty model has stats: %+v", model)
	}
	if len(model.Lanes) != 0 || len(model.Events) != 0 || len(model.Links) != 0 {
		t.Fatalf("empty model invented lanes/events/links: %+v", model)
	}
	if model.Lanes == nil || model.Events == nil || model.Links == nil {
		t.Fatalf("empty model slices must be non-nil for stable rendering")
	}
}

func TestSwimlaneFilterKeepsSenderToReceiverLinks(t *testing.T) {
	messages := []transcriptMessage{
		swimlaneMessage("m1", "agent-A", "self", "t1", "alpha A to master", 3000, 3),
		swimlaneMessage("m2", "agent-B", "self", "t2", "beta B to master", 1000, 1),
		swimlaneMessage("m3", "agent-A", "self", "t1", "alpha A again", 2000, 2),
	}
	model := buildCollabSwimlane(messages, "self")

	filtered := filterCollabSwimlane(model, "alpha")
	if filtered.Records != 2 {
		t.Fatalf("filtered records = %d, want 2", filtered.Records)
	}
	want := map[string]int{"agent-A>self": 2}
	if len(filtered.Links) != len(want) {
		t.Fatalf("filtered links = %+v, want %d pair", filtered.Links, len(want))
	}
	for _, link := range filtered.Links {
		key := link.From + ">" + link.To
		if link.Count != want[key] {
			t.Fatalf("filtered link %s count = %d, want %d", key, link.Count, want[key])
		}
	}
}

func TestSwimlaneNameAndInitialAreDerivedFromIdentity(t *testing.T) {
	if got, want := collabAgentName("agent-A"), "A"; got != want {
		t.Fatalf("name agent-A = %q, want %q", got, want)
	}
	if got, want := collabAgentInitial("agent-A"), "A"; got != want {
		t.Fatalf("initial agent-A = %q, want %q", got, want)
	}
	if got, want := collabAgentName(""), "未知 Agent"; got != want {
		t.Fatalf("name empty = %q, want %q", got, want)
	}
}
