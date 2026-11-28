package main

import (
	"testing"
)

// A task that has stopped or completed cannot run another turn, whatever its
// master node last reported. This install has exactly that shape in the running
// session: the task is stopped, the master is idle, and one tool message is still
// marked pending - so the round read as running forever and the composer kept
// offering 暂停 with nothing left to pause.
func TestAStoppedTaskDoesNotKeepThePauseAction(t *testing.T) {
	state := &chatState{
		roundMaster: "idle",
		messages: []transcriptMessage{
			{Role: "user", Text: "问", State: "delivered"},
			{Role: "tool", Kind: "tool", Text: "bash: ls", State: "pending"},
		},
	}
	if state.busy() {
		t.Fatalf("a stopped task with an idle master is not work to pause, phase %v", state.roundPhase())
	}
	if mode := state.composerMode(); mode != composerSend {
		t.Fatalf("the composer offers send again once the task stopped, mode %v", mode)
	}
}

// A master that is actually running still owns the pause action.
func TestARunningMasterKeepsThePauseAction(t *testing.T) {
	state := &chatState{
		roundMaster: "running",
		messages: []transcriptMessage{
			{Role: "user", Text: "问", State: "delivered"},
			{Role: "tool", Kind: "tool", Text: "bash: ls", State: "pending"},
		},
	}
	if !state.busy() || state.composerMode() != composerPause {
		t.Fatalf("a running master is work to pause, phase %v", state.roundPhase())
	}
}

// A master that already settled must not be counted as work to pause, even while
// a tool row still says pending.
func TestASucceededMasterDoesNotKeepThePauseAction(t *testing.T) {
	state := &chatState{
		roundMaster: "succeeded",
		messages: []transcriptMessage{
			{Role: "user", Text: "问", State: "delivered"},
			{Role: "tool", Kind: "tool", Text: "bash: ls", State: "pending"},
		},
	}
	if state.busy() {
		t.Fatalf("a succeeded master is not work to pause, phase %v", state.roundPhase())
	}
}
