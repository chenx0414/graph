package main

import (
	"testing"

	"github.com/chenx0414/graph/backend/statemachine"
)

func TestUIRecognisesEveryStateItRenders(t *testing.T) {
	for _, id := range []string{"task.phase", "node.status", "fleet.agent_status"} {
		machine, ok := statemachine.Lookup(id)
		if !ok {
			t.Fatalf("%s is not declared", id)
		}
		for _, state := range machine.States {
			if got := workStatusOf(state.Name); got == workUnknown {
				t.Errorf("%s state %q renders as raw text; teach the UI its status and label", id, state.Name)
				continue
			}
			if label := fleetStatusLabel(state.Name); label == state.Name {
				t.Errorf("%s state %q has no label in the UI", id, state.Name)
			}
		}
	}
}

func TestStateMachinePayloadCarriesUIWording(t *testing.T) {
	for _, machine := range statemachine.All() {
		for _, state := range machine.States {
			if state.Name == "" || state.Label == "" {
				t.Fatalf("%s publishes an unlabeled state %+v", machine.ID, state)
			}
		}
	}
}
