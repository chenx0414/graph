package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRoundPhaseOfTheServerSignals(t *testing.T) {
	cases := []struct {
		name     string
		paused   bool
		master   string
		messages []transcriptMessage
		want     roundPhase
	}{
		{"an idle conversation", false, "done", nil, roundIdle},
		{"the master node is preparing", false, "preparing", nil, roundPreparing},
		{"the master node is running", false, "running", nil, roundRunning},
		{"the master node waits for an answer", false, "blocked", nil, roundBlocked},
		{"the user paused the round", true, "running", nil, roundPaused},
		{"an unknown status is not a round", false, "legendary", nil, roundIdle},
		{"a live reply is being written", false, "", []transcriptMessage{{Role: "assistant", State: "streaming", Text: "半句"}}, roundRunning},
		{"a tool is still working", false, "", []transcriptMessage{{Role: "tool", State: "running", Text: "bash"}}, roundRunning},
		{"a tool is registered but not started", false, "", []transcriptMessage{{Role: "tool", State: "pending", Text: "bash"}}, roundRunning},
		{"my prompt is queued behind the round", false, "", []transcriptMessage{{Role: "user", State: "queued", Text: "再问一句"}}, roundQueued},
		{"a delivered prompt is history", false, "", []transcriptMessage{{Role: "user", State: "delivered", Text: "问过了"}, {Role: "assistant", State: "done", Text: "答"}}, roundIdle},
		{"a prompt waiting to be dispatched is not a round", false, "", []transcriptMessage{{Role: "user", State: "pending", Text: "刚发出"}}, roundIdle},
		{"a cancelled tool no longer runs", false, "", []transcriptMessage{{Role: "tool", State: "cancelled", Text: "bash"}}, roundIdle},
		{"a failed tool no longer runs", false, "", []transcriptMessage{{Role: "tool", State: "failed", Text: "bash"}}, roundIdle},
	}
	for _, sample := range cases {
		if got := roundPhaseOf(sample.paused, sample.master, sample.messages); got != sample.want {
			t.Fatalf("%s: phase %v, want %v", sample.name, got, sample.want)
		}
	}
}

func roundServer(t *testing.T, payload string) *chatState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	return state
}

func TestAQueuedPromptAloneLeavesTheRoundOff(t *testing.T) {
	state := &chatState{messages: []transcriptMessage{{Role: "user", Text: "等下一轮", State: "queued"}}}
	if state.busy() {
		t.Fatal("a queued prompt with no running round is not work to pause")
	}
	if mode := state.composerMode(); mode != composerSend {
		t.Fatalf("the composer still sends, mode %v", mode)
	}
}

func TestTheMasterNodeSayingRunningTurnsTheButtonIntoPause(t *testing.T) {
	state := roundServer(t, `{"paused":false,"master":{"status":"running"},"messages":[{"role":"user","text":"跑一下","state":"delivered"}]}`)
	if !state.busy() {
		t.Fatal("the master node status says the round is running")
	}
	if mode := state.composerMode(); mode != composerPause {
		t.Fatalf("a running round turns the send button into pause, mode %v", mode)
	}
}

func TestAFinishedRoundLeavesTheSendButtonAlone(t *testing.T) {
	state := roundServer(t, `{"paused":false,"master":{"status":"done"},"messages":[{"role":"user","text":"问","state":"delivered"},{"role":"assistant","text":"答","state":"done"}]}`)
	if state.busy() {
		t.Fatal("a delivered prompt and a settled reply are history")
	}
	if mode := state.composerMode(); mode != composerSend {
		t.Fatalf("an idle round sends again, mode %v", mode)
	}
}

func TestACancelledToolIsNoLongerRunning(t *testing.T) {
	run := transcriptRun{tools: true, messages: []transcriptMessage{{
		Role: "tool", State: "cancelled", Text: "bash",
		Data: transcriptMessageData{Tool: "bash", Command: "make build"},
	}}}
	activities := codexActivities(run)
	if len(activities) != 1 {
		t.Fatalf("activities %+v", activities)
	}
	if strings.Contains(activities[0].text, "正在运行") {
		t.Fatalf("a cancelled tool must not read as running: %q", activities[0].text)
	}
	if !activities[0].cancelled || !strings.Contains(activities[0].text, "已取消") {
		t.Fatalf("a cancelled tool reads as cancelled: %+v", activities[0])
	}
}

func TestFollowStopsWhenAToolOnlyRoundEnds(t *testing.T) {
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		polls++
		if polls < 2 {
			_, _ = w.Write([]byte(`{"master":{"status":"running"},"messages":[{"role":"user","text":"跑一下","state":"delivered"},{"role":"tool","text":"bash","state":"running"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"master":{"status":"done"},"messages":[{"role":"user","text":"跑一下","state":"delivered"},{"role":"tool","text":"bash","state":"cancelled"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.active = "c1"
	done := make(chan struct{})
	go func() {
		state.follow()
		close(done)
	}()
	// The follower writes on the shell's owner, so the test runs that work while
	// it waits for the follower to finish.
	timeout := time.After(3 * time.Second)
wait:
	for {
		select {
		case <-done:
			break wait
		case <-timeout:
			t.Fatal("a finished tool-only round must stop the follow")
		default:
			waitForUI()
			time.Sleep(time.Millisecond)
		}
	}
	if polls > 3 {
		t.Fatalf("the follower keeps polling a finished round, polls %d", polls)
	}
	if len(state.messages) != 2 || state.messages[1].State != "cancelled" {
		t.Fatalf("messages %+v", state.messages)
	}
}

func TestARefreshReportsARoundThatStartedOrEnded(t *testing.T) {
	payload := `{"paused":false,"master":{"status":"running"},"messages":[{"role":"user","text":"跑一下","state":"delivered"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	if changed, _ := state.source.Refresh(state); changed {
		t.Fatal("an unchanged polling round is not a change")
	}
	payload = `{"paused":false,"master":{"status":"done"},"messages":[{"role":"user","text":"跑一下","state":"delivered"}]}`
	if changed, _ := state.source.Refresh(state); !changed {
		t.Fatal("the round ending must redraw the composer")
	}
}
