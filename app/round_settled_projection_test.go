package main

import (
	"testing"
)

// A stopped task with an idle master and a pending tool row is this install's shape.
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

// A settled master is not work to pause.
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
