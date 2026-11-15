package statemachine

import (
	"embed"
	"encoding/json"
	"sort"
	"sync"
)

const RegistryVersion = 1

type Tone string

const (
	ToneRunning Tone = "running"
	ToneIdle    Tone = "idle"
	ToneBlocked Tone = "blocked"
	ToneSuccess Tone = "success"
	ToneDanger  Tone = "danger"
	ToneMuted   Tone = "muted"
)

var tones = map[Tone]bool{
	ToneRunning: true, ToneIdle: true, ToneBlocked: true,
	ToneSuccess: true, ToneDanger: true, ToneMuted: true,
}

type State struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Tone     Tone   `json:"tone,omitempty"`
	Terminal bool   `json:"terminal,omitempty"`
}

type Target struct {
	Table  string `json:"table"`
	Column string `json:"column"`
}

type Transition struct {
	From string `json:"from"`
	To   string `json:"to"`
	On   string `json:"on,omitempty"`
}

type Machine struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Store       string       `json:"store"`
	Owner       string       `json:"owner,omitempty"`
	Targets     []Target     `json:"targets,omitempty"`
	Initial     []string     `json:"initial,omitempty"`
	States      []State      `json:"states"`
	Transitions []Transition `json:"transitions,omitempty"`
}

type document struct {
	Version  int       `json:"version"`
	Machines []Machine `json:"machines"`
}

type index struct {
	Version int      `json:"version"`
	Parts   []string `json:"parts"`
}

//go:embed machines.json machines/*.json
var registryFS embed.FS

var (
	registryOnce sync.Once
	registry     document
	registryErr  error
	byID         map[string]int
	byTarget     map[Target]int
)

func load() {
	registryOnce.Do(func() {
		parsed, err := readRegistry()
		if err != nil {
			registryErr = err
			return
		}
		byID = make(map[string]int, len(parsed.Machines))
		byTarget = make(map[Target]int, len(parsed.Machines))
		for index, machine := range parsed.Machines {
			byID[machine.ID] = index
			for _, target := range machine.Targets {
				byTarget[target] = index
			}
		}
		registry = parsed
	})
}

func readRegistry() (document, error) {
	indexPayload, err := registryFS.ReadFile("machines.json")
	if err != nil {
		return document{}, err
	}
	var table index
	if err := json.Unmarshal(indexPayload, &table); err != nil {
		return document{}, err
	}
	merged := document{Version: table.Version}
	for _, part := range table.Parts {
		partPayload, readErr := registryFS.ReadFile(part)
		if readErr != nil {
			return document{}, readErr
		}
		var chunk document
		if unmarshalErr := json.Unmarshal(partPayload, &chunk); unmarshalErr != nil {
			return document{}, unmarshalErr
		}
		merged.Machines = append(merged.Machines, chunk.Machines...)
	}
	return merged, nil
}

func All() []Machine {
	load()
	if registryErr != nil {
		return nil
	}
	return registry.Machines
}

func Lookup(id string) (Machine, bool) {
	load()
	if registryErr != nil {
		return Machine{}, false
	}
	index, ok := byID[id]
	if !ok {
		return Machine{}, false
	}
	return registry.Machines[index], true
}

func MachineFor(table, column string) (Machine, bool) {
	load()
	if registryErr != nil {
		return Machine{}, false
	}
	index, ok := byTarget[Target{Table: table, Column: column}]
	if !ok {
		return Machine{}, false
	}
	return registry.Machines[index], true
}

func (m Machine) State(name string) (State, bool) {
	for _, state := range m.States {
		if state.Name == name {
			return state, true
		}
	}
	return State{}, false
}

func (m Machine) Allows(from, to string) (bool, bool) {
	if _, ok := m.State(from); !ok {
		return false, false
	}
	if _, ok := m.State(to); !ok {
		return false, false
	}
	for _, transition := range m.Transitions {
		if transition.From != from && transition.From != "*" {
			continue
		}
		if transition.To == to {
			return true, true
		}
	}
	return false, true
}

func Label(machineID, state string) string {
	machine, ok := Lookup(machineID)
	if !ok {
		return state
	}
	if found, ok := machine.State(state); ok {
		return found.Label
	}
	return state
}

func ToneOf(machineID, state string) Tone {
	machine, ok := Lookup(machineID)
	if !ok {
		return ToneMuted
	}
	if found, ok := machine.State(state); ok && found.Tone != "" {
		return found.Tone
	}
	return ToneMuted
}

func JSON() []byte {
	load()
	if registryErr != nil {
		return nil
	}
	encoded, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return nil
	}
	return encoded
}

func Validate(machines []Machine) []string {
	problems := []string{}
	ids := map[string]bool{}
	targets := map[Target]bool{}
	for _, machine := range machines {
		if machine.ID == "" || machine.Title == "" || machine.Store == "" {
			problems = append(problems, "a machine is missing id, title or store")
			continue
		}
		if ids[machine.ID] {
			problems = append(problems, "duplicate machine "+machine.ID)
		}
		ids[machine.ID] = true
		if len(machine.States) == 0 {
			problems = append(problems, machine.ID+" declares no states")
		}
		for _, target := range machine.Targets {
			if targets[target] {
				problems = append(problems, "target "+target.Table+"."+target.Column+" is declared twice")
			}
			targets[target] = true
		}
		states := map[string]bool{}
		for _, state := range machine.States {
			if state.Name == "" || state.Label == "" {
				problems = append(problems, machine.ID+" has a state without name or label")
				continue
			}
			if states[state.Name] {
				problems = append(problems, machine.ID+" declares state "+state.Name+" twice")
			}
			states[state.Name] = true
			if state.Tone != "" && !tones[state.Tone] {
				problems = append(problems, machine.ID+" state "+state.Name+" has unknown tone "+string(state.Tone))
			}
		}
		for _, name := range machine.Initial {
			if !states[name] {
				problems = append(problems, machine.ID+" starts in undeclared state "+name)
			}
		}
		for _, transition := range machine.Transitions {
			if transition.From != "*" && !states[transition.From] {
				problems = append(problems, machine.ID+" leaves from undeclared state "+transition.From)
			}
			if !states[transition.To] {
				problems = append(problems, machine.ID+" enters undeclared state "+transition.To)
			}
		}
	}
	sort.Strings(problems)
	return problems
}
