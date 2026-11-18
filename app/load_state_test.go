package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

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
	var state loadState[conversationTrajectory]
	generation, start := state.begin()
	if !start {
		t.Fatal("an idle machine must start a request")
	}
	state.reset()
	if state.settle(generation, &conversationTrajectory{ConversationId: "c1"}, "") {
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
	var state loadState[conversationTrajectory]
	generation, start := state.begin()
	if !start {
		t.Fatal("the first begin must start")
	}
	if second, again := state.begin(); again || second != generation {
		t.Fatalf("a loading machine must not start a second request: %d %v", second, again)
	}
	if !state.settle(generation, &conversationTrajectory{ConversationId: "c1"}, "") {
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
	var state loadState[conversationTrajectory]
	generation, _ := state.begin()
	state.settle(generation, nil, "读不到轨迹：连接被拒绝")
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
