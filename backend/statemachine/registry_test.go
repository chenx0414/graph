package statemachine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The state machine vocabulary is content, not prose: machines.json declares it and
// `graphcheck machines` proves it matches the source. The two documents that used to
// mirror it were a second copy that could drift, so what remains here is the guarantee
// that the vocabulary stays complete and readable on its own.
func TestRegistryCarriesEverythingAReaderNeeds(t *testing.T) {
	machines := All()
	if len(machines) == 0 {
		t.Fatal("the registry is empty")
	}
	for _, machine := range machines {
		if machine.ID == "" || machine.Title == "" {
			t.Errorf("%q needs both an id and a title: %+v", machine.ID, machine)
		}
		if len(machine.States) == 0 {
			t.Errorf("%s declares no states", machine.ID)
		}
		for _, state := range machine.States {
			if state.Name == "" {
				t.Errorf("%s declares a state with no value", machine.ID)
			}
			if state.Label == "" {
				t.Errorf("%s.%s has no label; the interface and the agent both read it", machine.ID, state.Name)
			}
		}
		for _, target := range machine.Targets {
			if target.Table == "" || target.Column == "" {
				t.Errorf("%s declares a target with no table or column: %+v", machine.ID, target)
			}
		}
	}
}

func TestRegistryIsTheOnlyStateVocabulary(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repo: %v", err)
	}
	stale := []string{
		"docs/agent/state-machines.md",
		"docs/agent/state-machines-reference.md",
		"docs/specs/implicit-state-machines.md",
	}
	for _, relative := range stale {
		if _, statErr := os.Stat(filepath.Join(root, relative)); statErr == nil {
			t.Errorf("%s mirrors machines.json; the registry is the only vocabulary, and `graphcheck machines --verbose` prints it", relative)
		}
	}
	payload, err := os.ReadFile(filepath.Join(root, "backend", "statemachine", "machines.json"))
	if err != nil {
		t.Fatalf("read machines.json: %v", err)
	}
	if !strings.Contains(string(payload), "parts") {
		t.Fatalf("machines.json no longer indexes its parts, so a reader cannot find the shards")
	}
}
