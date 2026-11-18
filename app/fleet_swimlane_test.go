package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func swimlaneState(t *testing.T) *shellState {
	t.Helper()
	state := fleetServerShell(t, fleetSampleServer)
	openFleetTester(t, state)
	return state
}

func TestTheCollaborationCardShowsOneLanePerAgent(t *testing.T) {
	state := swimlaneState(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	model := buildFleetSwimlane(state.fleet.data, "", true)
	if len(model.Lanes) != 4 {
		t.Fatalf("one lane per participating agent, got %+v", model.Lanes)
	}
	for _, want := range []string{"主控", "13-Graph", "planner", "worker"} {
		if !tester.HasText(want) {
			t.Fatalf("lane %q is listed, texts %q", want, tester.Texts())
		}
	}
}

func TestTheCollaborationCardCountsRecordsAndLanes(t *testing.T) {
	state := swimlaneState(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("3/3 条记录") {
		t.Fatalf("the header counts the records, texts %q", tester.Texts())
	}
	if !tester.HasText("4 条泳道") {
		t.Fatalf("the header counts the lanes, texts %q", tester.Texts())
	}
}

func TestTheCollaborationCardPlacesEventsInTimeColumns(t *testing.T) {
	state := swimlaneState(t)
	model := buildFleetSwimlane(state.fleet.data, "", true)
	if len(model.Columns) != 3 {
		t.Fatalf("three distinct event times make three columns, got %+v", model.Columns)
	}
	if model.Columns[0].At <= model.Columns[2].At {
		t.Fatalf("newest first orders the columns, got %+v", model.Columns)
	}
	oldest := buildFleetSwimlane(state.fleet.data, "", false)
	if oldest.Columns[0].At >= oldest.Columns[2].At {
		t.Fatalf("earliest first orders the other way, got %+v", oldest.Columns)
	}
}

func TestTheCollaborationCardLinksSenderAndReceiver(t *testing.T) {
	state := swimlaneState(t)
	model := buildFleetSwimlane(state.fleet.data, "", true)
	if len(model.Marks) != 3 {
		t.Fatalf("every event is a mark, got %+v", model.Marks)
	}
	for _, mark := range model.Marks {
		if mark.From < 0 || mark.To < 0 {
			t.Fatalf("every mark carries both ends, got %+v", mark)
		}
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("协作事件 3"); err != nil {
		t.Fatalf("click the third mark: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("planner → worker") {
		t.Fatalf("the picked mark names both ends, texts %q", tester.Texts())
	}
	if !tester.HasText("planner 投递 交接说明") {
		t.Fatalf("the picked mark shows its text, texts %q", tester.Texts())
	}
}

func TestTheCollaborationCardSearchesLanesAndKeepsLinks(t *testing.T) {
	state := swimlaneState(t)
	all := buildFleetSwimlane(state.fleet.data, "", true)
	planner := buildFleetSwimlane(state.fleet.data, "planner", true)
	if len(planner.Marks) == 0 || len(planner.Marks) >= len(all.Marks) {
		t.Fatalf("search narrows the marks, got %d of %d", len(planner.Marks), len(all.Marks))
	}
	for _, mark := range planner.Marks {
		if mark.To < 0 {
			t.Fatalf("a filtered mark keeps its receiver, got %+v", mark)
		}
	}
}

func TestTheCollaborationCardInventsNothingWhenEmpty(t *testing.T) {
	empty := buildFleetSwimlane(&fleetSnapshot{}, "", true)
	if len(empty.Lanes) != 0 || len(empty.Marks) != 0 || len(empty.Columns) != 0 {
		t.Fatalf("an empty fleet invents no lanes, got %+v", empty)
	}
}
