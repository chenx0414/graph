package graph

import (
	"testing"

	"github.com/chenx0414/graph/backend/statemachine"
)

func registryMachine(t *testing.T, id string) statemachine.Machine {
	t.Helper()
	machine, ok := statemachine.Lookup(id)
	if !ok {
		t.Fatalf("registry has no machine %q", id)
	}
	return machine
}

func TestRegistryDeclaresEveryMessageState(t *testing.T) {
	machine := registryMachine(t, "message.state")
	for _, state := range []MessageState{
		MessageStatePending, MessageStateQueued, MessageStateDelivered, MessageStateRunning,
		MessageStateDone, MessageStateFailed, MessageStateCancelled,
	} {
		if _, ok := machine.State(string(state)); !ok {
			t.Errorf("message.state does not declare %q, which the store writes", state)
		}
	}
}

func TestRegistryDeclaresMessageTransitionsTheStorePerforms(t *testing.T) {
	machine := registryMachine(t, "message.state")
	for _, edge := range [][2]MessageState{
		{MessageStatePending, MessageStateDelivered},
		{MessageStateQueued, MessageStateDelivered},
		{MessageStateDelivered, MessageStatePending},
		{MessageStatePending, MessageStateCancelled},
		{MessageStateQueued, MessageStateCancelled},
		{MessageStateRunning, MessageStateDone},
		{MessageStateRunning, MessageStateFailed},
	} {
		allowed, known := machine.Allows(string(edge[0]), string(edge[1]))
		if !known || !allowed {
			t.Errorf("message.state does not allow %s -> %s (known=%v)", edge[0], edge[1], known)
		}
	}
}

func TestRegistryDeclaresEveryDeferredToolCallState(t *testing.T) {
	machine := registryMachine(t, "deferred_tool_call.state")
	for _, state := range []DeferredToolCallState{
		DeferredToolAccepted, DeferredToolRunning, DeferredToolSettled, DeferredToolFailed,
		DeferredToolCancelled, DeferredToolTimedOut, DeferredToolInterrupted,
	} {
		if _, ok := machine.State(string(state)); !ok {
			t.Errorf("deferred_tool_call.state does not declare %q", state)
		}
	}
	for _, edge := range [][2]DeferredToolCallState{
		{DeferredToolAccepted, DeferredToolRunning},
		{DeferredToolAccepted, DeferredToolCancelled},
		{DeferredToolRunning, DeferredToolSettled},
		{DeferredToolRunning, DeferredToolFailed},
		{DeferredToolRunning, DeferredToolCancelled},
		{DeferredToolRunning, DeferredToolTimedOut},
		{DeferredToolRunning, DeferredToolInterrupted},
	} {
		allowed, known := machine.Allows(string(edge[0]), string(edge[1]))
		if !known || !allowed {
			t.Errorf("deferred_tool_call.state does not allow %s -> %s (known=%v)", edge[0], edge[1], known)
		}
	}
}

func TestRegistryDeclaresEveryStoredGraphPhase(t *testing.T) {
	machine := registryMachine(t, "task.phase")
	for _, phase := range []GraphPhase{
		PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle,
		PhaseBlocked, PhaseCompleting, PhaseCompleted, PhaseStopping, PhaseStopped, PhaseAbandoned,
	} {
		if _, ok := machine.State(string(phase)); !ok {
			t.Errorf("task.phase does not declare stored phase %q", phase)
		}
	}
	if _, ok := machine.State(string(PhasePaused)); ok {
		t.Errorf("task.phase must not store the presentation phase %q", PhasePaused)
	}
}

func TestRegistryDeclaresEveryNodeStatusTheStoreWrites(t *testing.T) {
	machine := registryMachine(t, "node.status")
	for _, status := range []string{"pending", "preparing", "running", "idle", "blocked", "failed", "succeeded", "skipped", "retired"} {
		if _, ok := machine.State(status); !ok {
			t.Errorf("node.status does not declare %q, which the store writes", status)
		}
	}
}
