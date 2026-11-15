package statemachine

import (
	"encoding/json"
	"testing"
)

func TestRegistryIsInternallyConsistent(t *testing.T) {
	for _, problem := range Validate(All()) {
		t.Errorf("registry: %s", problem)
	}
}

func TestEveryTableTargetResolvesToItsMachine(t *testing.T) {
	for _, machine := range All() {
		if machine.Store == "derived" {
			if len(machine.Targets) != 0 {
				t.Errorf("%s is derived but claims table targets", machine.ID)
			}
			continue
		}
		if len(machine.Targets) == 0 {
			t.Errorf("%s has no table target", machine.ID)
		}
		for _, target := range machine.Targets {
			found, ok := MachineFor(target.Table, target.Column)
			if !ok || found.ID != machine.ID {
				t.Errorf("%s.%s resolves to %q", target.Table, target.Column, found.ID)
			}
		}
	}
}

func TestAllowsRejectsUndeclaredEdges(t *testing.T) {
	machine, ok := Lookup("task.phase")
	if !ok {
		t.Fatal("task.phase must be declared")
	}
	if allowed, known := machine.Allows("running", "blocked"); !allowed || !known {
		t.Fatalf("running -> blocked must be declared, got allowed=%v known=%v", allowed, known)
	}
	if allowed, known := machine.Allows("running", "discussing"); allowed || !known {
		t.Fatalf("running -> discussing must be refused, got allowed=%v known=%v", allowed, known)
	}
	if _, known := machine.Allows("running", "unheard_of"); known {
		t.Fatal("an undeclared target state must report unknown")
	}
}

func TestWildcardTransitionCoversEveryState(t *testing.T) {
	machine, _ := Lookup("task.phase")
	for _, state := range machine.States {
		if state.Name == "abandoned" {
			continue
		}
		if allowed, _ := machine.Allows(state.Name, "abandoned"); !allowed {
			t.Fatalf("%s -> abandoned must be allowed", state.Name)
		}
	}
}

func TestLabelsAndTonesAreOneVocabulary(t *testing.T) {
	if label := Label("fleet.agent_status", "done"); label != "已完成" {
		t.Fatalf("done label is %q", label)
	}
	if tone := ToneOf("fleet.agent_status", "failed"); tone != ToneDanger {
		t.Fatalf("failed tone is %q", tone)
	}
	if label := Label("fleet.agent_status", "not_a_state"); label != "not_a_state" {
		t.Fatalf("an unknown state must fall back to its raw name, got %q", label)
	}
	if tone := ToneOf("fleet.agent_status", "not_a_state"); tone != ToneMuted {
		t.Fatalf("an unknown state must fall back to muted, got %q", tone)
	}
}

func TestTerminalStatesHaveNoOutgoingEdges(t *testing.T) {
	for _, machine := range All() {
		for _, state := range machine.States {
			if !state.Terminal {
				continue
			}
			for _, transition := range machine.Transitions {
				if transition.From == state.Name {
					t.Errorf("%s: terminal state %s still leaves to %s", machine.ID, state.Name, transition.To)
				}
			}
		}
	}
}

func TestJSONRoundTripsThroughTheSchema(t *testing.T) {
	var parsed document
	if err := json.Unmarshal(JSON(), &parsed); err != nil {
		t.Fatalf("registry JSON does not parse: %v", err)
	}
	if parsed.Version != RegistryVersion {
		t.Fatalf("version is %d", parsed.Version)
	}
	if len(parsed.Machines) != len(All()) {
		t.Fatalf("document holds %d machines, loaded %d", len(parsed.Machines), len(All()))
	}
}
