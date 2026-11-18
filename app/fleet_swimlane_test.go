package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

func TestTheCollaborationCardPutsTheNewestRecordOnTheLeft(t *testing.T) {
	state := swimlaneState(t)
	model := buildFleetSwimlane(state.fleet.data, "", true)
	if len(model.Columns) != 3 {
		t.Fatalf("three distinct event times make three columns, got %+v", model.Columns)
	}
	if model.Columns[0].At <= model.Columns[2].At {
		t.Fatalf("the leftmost column is the newest record, got %+v", model.Columns)
	}
	oldest := buildFleetSwimlane(state.fleet.data, "", false)
	if oldest.Columns[0].At >= oldest.Columns[2].At {
		t.Fatalf("the 最早 toggle puts the oldest left, got %+v", oldest.Columns)
	}
}

func TestTheCollaborationCardKeepsOnlyTheRecentRecords(t *testing.T) {
	data := fleetSnapshot{Agents: []fleetAgent{{ID: "g1", Kind: "global", Name: "主控"}}, Events: []fleetEvent{}}
	for index := 0; index < fleetSwimMarkLimit+37; index++ {
		data.Events = append(data.Events, fleetEvent{
			ID: "e" + formatSeq(int64(index)), At: 1_700_000_000_000 + int64(index)*1000,
			Type: "link.delivery", AgentID: "g1", Text: "投递 " + formatSeq(int64(index)),
		})
	}
	model := buildFleetSwimlane(&data, "", true)
	if model.Records != fleetSwimMarkLimit || model.Hidden != 37 {
		t.Fatalf("the card keeps the most recent %d and counts %d hidden, got %d/%d", fleetSwimMarkLimit, 37, model.Records, model.Hidden)
	}
	if len(model.Marks) != fleetSwimMarkLimit {
		t.Fatalf("only the recent marks are drawn, got %d", len(model.Marks))
	}
	newest := model.Columns[0].At
	oldest := model.Columns[len(model.Columns)-1].At
	if newest <= oldest {
		t.Fatalf("newest sits left of oldest, got %d..%d", newest, oldest)
	}
	if oldest < data.Events[len(data.Events)-fleetSwimMarkLimit].At {
		t.Fatalf("the hidden records are the oldest ones, oldest kept %d", oldest)
	}
}

func TestTheCollaborationCardDrawsArrowheadsTowardTheReceiver(t *testing.T) {
	state := swimlaneState(t)
	model := buildFleetSwimlane(state.fleet.data, "", true)
	var linked *fleetSwimMark
	for index := range model.Marks {
		mark := model.Marks[index]
		if mark.From >= 0 && mark.To >= 0 && mark.From != mark.To {
			linked = &model.Marks[index]
			break
		}
	}
	if linked == nil {
		t.Fatalf("a two-lane event must exist in the sample, got %+v", model.Marks)
	}
	arrow := fleetSwimArrowLayout(linked.From, linked.To, linked.Column, 22, 76, 0, 20)
	if arrow.From != linked.From || arrow.To != linked.To {
		t.Fatalf("the arrow follows the event direction, got %+v", arrow)
	}
	if arrow.TipY <= arrow.TailY && linked.To > linked.From {
		t.Fatalf("the arrowhead points at the receiver row, got %+v", arrow)
	}
	if !arrow.Downward() {
		t.Fatalf("a receiver below the sender points down, got %+v", arrow)
	}
}

func TestTheCollaborationCardOpensTheMessageBehindAMark(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/conversations":
			_, _ = w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null}
			]`))
		case r.URL.Path == "/api/conversations/g1":
			_, _ = w.Write([]byte(`{"messages":[{"id":"x1","seq":1,"role":"assistant","text":"主控自己的会话","createdAt":1}]}`))
		case r.URL.Path == "/api/conversations/p1":
			_, _ = w.Write([]byte(conversationWithMarkMessageJSON()))
		case r.URL.Path == "/api/fleet":
			fleetSampleServer(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for state.fleet.data == nil && state.fleet.failed == "" {
		if !time.Now().Before(deadline) {
			t.Fatalf("the fleet data never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if tester.HasText("委派 实现四栏页面 落在第五十句") {
		t.Fatalf("the message behind the mark starts out of view, texts %q", tester.Texts())
	}
	if err := tester.Click("协作事件 1"); err != nil {
		t.Fatalf("click the first mark: %v", err)
	}
	tester = frames(tester)
	if state.activeID != "p1" {
		t.Fatalf("a mark opens the receiver's conversation, active %q", state.activeID)
	}
	if !tester.HasText("委派 实现四栏页面 落在第五十句") {
		t.Fatalf("the opened chat scrolls to the message behind the mark, texts %q", tester.Texts())
	}
}

func conversationWithMarkMessageJSON() string {
	parts := make([]string, 0, 60)
	for seq := 1; seq <= 60; seq++ {
		text := "第" + formatSeq(int64(seq)) + "句"
		if seq == 50 {
			text = "委派 实现四栏页面 落在第五十句"
		}
		parts = append(parts, `{"id":"m`+formatSeq(int64(seq))+`","seq":`+formatSeq(int64(seq))+`,"role":"assistant","text":"`+text+`","createdAt":`+formatSeq(1_700_000_000_000+int64(seq)*1000)+`}`)
	}
	return `{"messages":[` + strings.Join(parts, ",") + `]}`
}

func TestTheCollaborationCardInventsNothingWhenEmpty(t *testing.T) {
	empty := buildFleetSwimlane(&fleetSnapshot{}, "", true)
	if len(empty.Lanes) != 0 || len(empty.Marks) != 0 || len(empty.Columns) != 0 {
		t.Fatalf("an empty fleet invents no lanes, got %+v", empty)
	}
}
