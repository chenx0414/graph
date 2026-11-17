package controls

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Derive turns journeys that already pass into witnesses. It is the honest way
// to grow coverage: it never invents an action, it searches the scenario files
// for a step that drives the control, then runs the same proof the audit runs
// (action step, later assertion, green recorded evidence, right lane). Anything
// it cannot prove stays unresolved for a human to drive or to mark blocked.
func Derive(inventory Inventory, scenarioDir, evidenceRoot string) ([]Witness, []string, []Problem) {
	scenarios := []Scenario{}
	entries, err := os.ReadDir(scenarioDir)
	if err != nil {
		return nil, nil, []Problem{{Code: "scenarios-unreadable", Detail: err.Error()}}
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(scenarioDir, entry.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var scenario Scenario
		if json.Unmarshal(raw, &scenario) != nil || len(scenario.Steps) == 0 {
			continue
		}
		if scenario.ID == "" {
			scenario.ID = strings.TrimSuffix(entry.Name(), ".json")
		}
		scenarios = append(scenarios, scenario)
	}
	sort.Slice(scenarios, func(i, j int) bool { return scenarios[i].ID < scenarios[j].ID })

	witnesses := []Witness{}
	unresolved := []string{}
	for _, control := range inventory.Controls {
		best := Witness{}
		bestLane := ""
		bestScore := -1
		reasons := []string{}
		for _, scenario := range scenarios {
			for index, step := range scenario.Steps {
				action, ok := actionForStep(control.Role, step)
				if !ok || step.Name != control.Name {
					continue
				}
				candidate := Witness{
					Name: control.Name, Role: control.Role, Page: control.Page,
					Action: action, Journey: scenario.ID, Step: index + 1,
				}
				proof := proveWitness(control, candidate, scenarioDir, evidenceRoot)
				if !proof.OK {
					reasons = append(reasons, proof.Reason)
					continue
				}
				score := 1
				required := requiredLanes(control, candidate)
				if len(required) > 0 && laneAllowed(proof.Lane, required) {
					score = 2
				}
				if score > bestScore {
					best, bestLane, bestScore = candidate, proof.Lane, score
				}
			}
			if bestScore == 2 {
				break
			}
		}
		if bestScore < 0 {
			unresolved = append(unresolved, display(control))
			continue
		}
		best.Lanes = []string{bestLane}
		best.Note = "derived from a green journey; kept by cover derive"
		witnesses = append(witnesses, best)
	}
	problems := []Problem{}
	if len(unresolved) > 0 {
		problems = append(problems, Problem{Code: "controls-unresolved",
			Detail: fmt.Sprintf("%d control(s) have no green journey step yet; drive them or mark them blocked", len(unresolved))})
	}
	return witnesses, unresolved, problems
}

func actionForStep(role string, step Step) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "textfield", "textbox", "searchfield", "combobox":
		return "type", step.Verb == "type" && step.Text != ""
	}
	switch step.Verb {
	case "click", "clickIf":
		return "click", true
	case "key":
		return "key", true
	}
	return "", false
}

// WriteLedger writes the ledger deterministically so a diff only shows real
// changes in the claims.
func WriteLedger(path string, ledger Ledger) error {
	if ledger.Schema == 0 {
		ledger.Schema = 1
	}
	sort.SliceStable(ledger.Witnesses, func(i, j int) bool {
		if ledger.Witnesses[i].Page != ledger.Witnesses[j].Page {
			return ledger.Witnesses[i].Page < ledger.Witnesses[j].Page
		}
		if ledger.Witnesses[i].Role != ledger.Witnesses[j].Role {
			return ledger.Witnesses[i].Role < ledger.Witnesses[j].Role
		}
		return ledger.Witnesses[i].Name < ledger.Witnesses[j].Name
	})
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, markGenerated(raw), 0o644)
}
