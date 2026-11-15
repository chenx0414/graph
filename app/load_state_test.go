package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const insightsSevenDayJSON = `{"days":[{"date":"2026-11-10","requests":7,"tokens":700,"cost":0.07,"cacheHitRate":0.5}],
	"totals":{"requests":7,"tokens":700,"cost":0.07,"cacheHitRate":0.5,"sessions":0},"sessions":[]}`

const insightsThirtyDayJSON = `{"days":[{"date":"2026-10-20","requests":30,"tokens":3000,"cost":0.3,"cacheHitRate":0.5}],
	"totals":{"requests":30,"tokens":3000,"cost":0.3,"cacheHitRate":0.5,"sessions":0},"sessions":[]}`

func waitFor(t *testing.T, label string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s never happened", label)
}

func TestInsightsKeepsTheRangeTheUserPicked(t *testing.T) {
	releaseSeven := make(chan struct{})
	var releaseOnce sync.Once
	answerSeven := func() { releaseOnce.Do(func() { close(releaseSeven) }) }
	sevenAnswered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("days") {
		case "7":
			<-releaseSeven
			w.Write([]byte(insightsSevenDayJSON))
			close(sevenAnswered)
		case "30":
			w.Write([]byte(insightsThirtyDayJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer answerSeven()

	shell := newShellState(server.URL, "tok")
	shell.ensureInsights()
	shell.setInsightsDays(30)
	waitFor(t, "the 30-day range", func() bool {
		return shell.insights.data != nil && shell.insights.data.Totals.Requests == 30
	})
	answerSeven()
	<-sevenAnswered
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if got := shell.insights.data.Totals.Requests; got != 30 {
			t.Fatalf("a 7-day answer replaced the 30-day range the user picked: requests %d", got)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestInsightsLabelsTheRangeTheUserPicked(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("days") == "30" {
			w.Write([]byte(insightsThirtyDayJSON))
			return
		}
		w.Write([]byte(insightsSevenDayJSON))
	}))
	defer server.Close()

	shell := newShellState(server.URL, "tok")
	shell.setInsightsDays(30)
	shell.openModule("insights")
	waitFor(t, "the 30-day range", func() bool { return shell.insights.data != nil })
	tester := frames(ui.NewTester(shell.view, 1440, 900))
	if !tester.HasText("近 30 天还没有会话用量。") {
		t.Fatalf("the sessions card names the range the user picked, texts %q", tester.Texts())
	}
}

func TestTrajectoryKeepsTheScopeTheUserOpened(t *testing.T) {
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	answerFirst := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
	firstAnswered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1", "/api/conversations/c2":
			w.Write([]byte(`{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"在","createdAt":1}]}`))
		case "/api/conversations/c1/trajectory":
			<-releaseFirst
			w.Write([]byte(`{"conversationId":"c1","requests":[],"turns":[],"events":[]}`))
			close(firstAnswered)
		case "/api/conversations/c2/trajectory":
			w.Write([]byte(`{"conversationId":"c2","requests":[],"turns":[],"events":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer answerFirst()

	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	shell.ensureTrajectory()
	shell.selectConversation("c2")
	shell.ensureTrajectory()
	waitFor(t, "the trajectory of the chat the user opened", func() bool {
		return shell.trajectory.data != nil && shell.trajectory.data.ConversationId == "c2"
	})
	answerFirst()
	<-firstAnswered
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if got := shell.trajectory.data.ConversationId; got != "c2" {
			t.Fatalf("the previous chat's answer replaced the open chat's trajectory: conversation %q", got)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestLoadStateRejectsAnAnswerFromASupersededRequest(t *testing.T) {
	var state loadState[trajectoryInsights]
	generation, start := state.begin()
	if !start {
		t.Fatal("an idle machine must start a request")
	}
	state.reset()
	if state.settle(generation, &trajectoryInsights{Totals: insightTotals{Requests: 7}}, "") {
		t.Fatal("an answer from a superseded request must not settle the machine")
	}
	if state.data != nil || state.loading() || state.ready() {
		t.Fatalf("a discarded answer changed the machine: %+v", state)
	}
	if state.settle(generation, nil, "迟到的失败") {
		t.Fatal("a failure from a superseded request must be discarded too")
	}
	if state.failed != "" {
		t.Fatalf("a discarded failure reached the surface: %q", state.failed)
	}
}

func TestLoadStateStartsOnceUntilTheAnswerOrAReset(t *testing.T) {
	var state loadState[trajectoryInsights]
	generation, start := state.begin()
	if !start {
		t.Fatal("the first begin must start")
	}
	if second, again := state.begin(); again || second != generation {
		t.Fatalf("a loading machine must not start a second request: %d %v", second, again)
	}
	if !state.settle(generation, &trajectoryInsights{Totals: insightTotals{Requests: 30}}, "") {
		t.Fatal("the current request must settle")
	}
	if !state.ready() || state.loading() || state.data == nil {
		t.Fatalf("a settled answer makes the machine ready: %+v", state)
	}
	if _, again := state.begin(); again {
		t.Fatal("a ready machine must not refetch on every render")
	}
	state.reset()
	if _, again := state.begin(); !again {
		t.Fatal("a reset machine must fetch again")
	}
}

func TestLoadStateKeepsAFailureUntilTheNextAttempt(t *testing.T) {
	var state loadState[trajectoryInsights]
	generation, _ := state.begin()
	state.settle(generation, nil, "读不到洞察：连接被拒绝")
	if state.failed == "" || state.loading() || state.ready() {
		t.Fatalf("a failed answer must be visible and stop the spinner: %+v", state)
	}
	if _, start := state.begin(); !start {
		t.Fatal("a failed machine must allow a retry")
	}
	if state.failed != "" {
		t.Fatalf("a retry must clear the previous failure: %q", state.failed)
	}
}
