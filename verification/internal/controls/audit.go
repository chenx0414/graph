package controls

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Audit re-checks every inventory control against the ledger, the journey
// files and recorded evidence. scenarioDir is verification/scenarios and
// evidenceRoot is verification/evidence.
func Audit(inventoryPath, ledgerPath, scenarioDir, evidenceRoot string, inventory Inventory, ledger Ledger) Report {
	report := Report{
		Inventory: inventoryPath, Ledger: ledgerPath,
		Conclusions: []Conclusion{}, Problems: []Problem{},
	}
	journeys := map[string]bool{}
	lanes := map[string]bool{}
	matchedWitness := map[int]bool{}
	matchedNA := map[int]bool{}
	matchedBlocked := map[int]bool{}

	for _, control := range inventory.Controls {
		conclusion := Conclusion{
			ID: control.ID(), Name: control.Name, Role: control.Role, Page: control.Page,
			Feature: control.Feature, Bounds: control.Bounds,
		}
		witnessIndexes := matchWitnesses(control, ledger.Witnesses)
		naIndexes := matchExclusions(control, ledger.NotApplicable)
		blockedIndexes := matchExclusions(control, ledger.Blocked)
		for _, index := range witnessIndexes {
			matchedWitness[index] = true
		}
		for _, index := range naIndexes {
			matchedNA[index] = true
		}
		for _, index := range blockedIndexes {
			matchedBlocked[index] = true
		}
		total := len(witnessIndexes) + len(naIndexes) + len(blockedIndexes)
		if total > 1 {
			report.Problems = append(report.Problems, Problem{
				Code: "duplicate-conclusion", Control: display(control),
				Detail: fmt.Sprintf("%d conflicting ledger entries (witness %d, not-applicable %d, blocked %d); a control has exactly one conclusion",
					total, len(witnessIndexes), len(naIndexes), len(blockedIndexes)),
			})
			conclusion.Status = "blocked"
			conclusion.Reason = "the ledger gives this control more than one conclusion"
			report.Blocked++
			report.Conclusions = append(report.Conclusions, conclusion)
			continue
		}
		switch {
		case len(witnessIndexes) == 1:
			witness := ledger.Witnesses[witnessIndexes[0]]
			proof := proveWitness(control, witness, scenarioDir, evidenceRoot, ledger.EvidenceRuns)
			conclusion.Action = witness.Action
			conclusion.Journey = witness.Journey
			conclusion.Step = proof.Step
			conclusion.Lane = proof.Lane
			conclusion.Evidence = proof.Evidence
			if proof.OK {
				conclusion.Status = "covered"
				conclusion.Reason = proof.Reason
				report.Covered++
				journeys[cleanJourney(witness.Journey)] = true
				if proof.Lane != "" {
					lanes[proof.Lane] = true
				}
			} else {
				conclusion.Status = "blocked"
				conclusion.Reason = proof.Reason
				conclusion.Next = proof.Next
				report.Blocked++
				report.Problems = append(report.Problems, Problem{
					Code: "witness-unproven", Control: display(control),
					Detail: proof.Reason + nextSuffix(proof.Next),
				})
			}
		case len(naIndexes) == 1:
			entry := ledger.NotApplicable[naIndexes[0]]
			if strings.TrimSpace(entry.Reason) == "" {
				report.Problems = append(report.Problems, Problem{Code: "exclusion-without-reason", Control: display(control),
					Detail: "not-applicable needs a concrete reason (one-off, external system, unreachable, unstable to locate)"})
				conclusion.Status = "not-applicable"
				conclusion.Reason = "missing reason"
			} else {
				conclusion.Status = "not-applicable"
				conclusion.Reason = entry.Reason
			}
			report.NotApplicable++
		case len(blockedIndexes) == 1:
			entry := ledger.Blocked[blockedIndexes[0]]
			conclusion.Status = "blocked"
			conclusion.Reason = strings.TrimSpace(entry.Reason)
			conclusion.Next = strings.TrimSpace(entry.Next)
			if conclusion.Reason == "" || conclusion.Next == "" {
				report.Problems = append(report.Problems, Problem{Code: "blocked-incomplete", Control: display(control),
					Detail: "blocked needs both a reason and a next step so the next agent can continue"})
			}
			report.Blocked++
		default:
			conclusion.Status = "unknown"
			report.Problems = append(report.Problems, Problem{Code: "unowned-control", Control: display(control),
				Detail: "no witness and no exclusion: add a journey step that drives it, or mark it not-applicable/blocked with a reason"})
		}
		report.Conclusions = append(report.Conclusions, conclusion)
	}

	// The ledger must not grow stale: an entry for a control that is no longer
	// in the inventory is a hidden lie about what the UI still has.
	for index, witness := range ledger.Witnesses {
		if !matchedWitness[index] {
			report.Problems = append(report.Problems, Problem{Code: "stale-witness", Control: keyOf(witness.Name, witness.Role, witness.Page),
				Detail: "the inventory has no such control; refresh the inventory or delete the witness"})
		}
	}
	for index, entry := range ledger.NotApplicable {
		if !matchedNA[index] {
			report.Problems = append(report.Problems, Problem{Code: "stale-exclusion", Control: keyOf(entry.Name, entry.Role, entry.Page),
				Detail: "the inventory has no such control; refresh the inventory or delete the exclusion"})
		}
	}
	for index, entry := range ledger.Blocked {
		if !matchedBlocked[index] {
			report.Problems = append(report.Problems, Problem{Code: "stale-exclusion", Control: keyOf(entry.Name, entry.Role, entry.Page),
				Detail: "the inventory has no such control; refresh the inventory or delete the exclusion"})
		}
	}

	report.Total = len(inventory.Controls)
	report.Journeys = len(journeys)
	for lane := range lanes {
		report.Lanes = append(report.Lanes, lane)
	}
	sort.Strings(report.Lanes)
	sort.Slice(report.Problems, func(i, j int) bool {
		if report.Problems[i].Control != report.Problems[j].Control {
			return report.Problems[i].Control < report.Problems[j].Control
		}
		return report.Problems[i].Code < report.Problems[j].Code
	})
	return report
}

type proof struct {
	OK       bool
	Step     int
	Lane     string
	Evidence string
	Reason   string
	Next     string
}

// proveWitness turns a claim into a fact: the journey must contain the action
// step, a later assertion must observe a visible result, and the recorded run
// must show that step passed in a lane that can prove this control.
func proveWitness(control Control, witness Witness, scenarioDir, evidenceRoot string, runs []string) proof {
	journey := cleanJourney(witness.Journey)
	if journey == "" {
		return proof{Reason: "the witness names no journey", Next: "set witness.journey to a file under verification/scenarios"}
	}
	scenarioPath, scenario, err := loadScenario(scenarioDir, journey)
	if err != nil {
		return proof{Reason: err.Error(), Next: "fix witness.journey; list journeys with: ls verification/scenarios"}
	}
	actionIndex, actionErr := findActionStep(scenario, witness)
	if actionErr != nil {
		return proof{Reason: actionErr.Error(), Next: fmt.Sprintf("add a %s step for %q to %s, or point the witness at the step that already does it", witness.Action, control.Name, filepath.Base(scenarioPath))}
	}
	assertion, assertionErr := findAssertionAfter(scenario, actionIndex, witness)
	if assertionErr != nil {
		return proof{Reason: assertionErr.Error(), Next: fmt.Sprintf("add an assertion after step %d in %s that observes the visible result of %q", actionIndex, filepath.Base(scenarioPath), control.Name)}
	}
	required := requiredLanes(control, witness)
	evidence, evidenceErr := findEvidence(evidenceRoot, runs, control, witness, actionIndex, required, firstNonEmpty(scenario.Feature, scenario.ID))
	if evidenceErr != nil {
		return proof{Reason: evidenceErr.Error(), Next: witness.EvidenceHint(control)}
	}
	if !laneAllowed(evidence.Lane, required) {
		return proof{Reason: fmt.Sprintf("%q was driven in lane %q, but this control must be proven in %s", control.Name, firstNonEmpty(evidence.Lane, "unknown"), strings.Join(required, "/")),
			Next: fmt.Sprintf("rerun with: verify-graph verify --journey %s --lane window", journey)}
	}
	reason := fmt.Sprintf("%s %s in %s step %d, then %s", strings.Title(witness.Action), quote(control.Name), journey, actionIndex, describeAssertion(assertion))
	if strings.TrimSpace(witness.Expect) != "" {
		reason += " (expected " + quote(witness.Expect) + ")"
	}
	return proof{OK: true, Step: actionIndex, Lane: evidence.Lane, Evidence: evidence.Path, Reason: reason}
}

// EvidenceHint turns a broken evidence reference into a runnable command.
func (w Witness) EvidenceHint(control Control) string {
	return fmt.Sprintf("run: verify-graph verify --journey %s (then: verify-graph cover audit)", cleanJourney(w.Journey))
}

func cleanJourney(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimSuffix(name, ".json")
	name = filepath.Base(name)
	return name
}

func loadScenario(scenarioDir, name string) (string, Scenario, error) {
	candidates := []string{filepath.Join(scenarioDir, name+".json")}
	if strings.ContainsRune(name, os.PathSeparator) {
		candidates = append([]string{name}, candidates...)
	}
	for _, candidate := range candidates {
		raw, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var scenario Scenario
		if err := json.Unmarshal(raw, &scenario); err != nil {
			return candidate, Scenario{}, fmt.Errorf("%s is not a journey file: %w", candidate, err)
		}
		if scenario.ID == "" {
			scenario.ID = name
		}
		return candidate, scenario, nil
	}
	return "", Scenario{}, fmt.Errorf("journey %q does not exist under verification/scenarios", name)
}

func actionVerbs(action string) []string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "click", "toggle", "select", "open", "press":
		return []string{"click", "clickIf"}
	case "type", "input":
		return []string{"type"}
	case "key", "keyboard":
		return []string{"key"}
	}
	return nil
}

func findActionStep(scenario Scenario, witness Witness) (int, error) {
	verbs := actionVerbs(witness.Action)
	if len(verbs) == 0 {
		return 0, fmt.Errorf("witness action %q is not one of click|type|key|toggle|select|open", witness.Action)
	}
	if witness.Step > 0 {
		if witness.Step > len(scenario.Steps) {
			return 0, fmt.Errorf("journey %s has %d steps, witness points at %d", scenario.ID, len(scenario.Steps), witness.Step)
		}
		step := scenario.Steps[witness.Step-1]
		if !contains(verbs, step.Verb) {
			return 0, fmt.Errorf("journey %s step %d is %q, not %s", scenario.ID, witness.Step, step.Verb, strings.Join(verbs, "/"))
		}
		if step.Name != "" && witness.Name != "" && step.Name != witness.Name {
			return 0, fmt.Errorf("journey %s step %d drives %q, not %q", scenario.ID, witness.Step, step.Name, witness.Name)
		}
		return witness.Step, nil
	}
	for index, step := range scenario.Steps {
		if contains(verbs, step.Verb) && step.Name == witness.Name {
			return index + 1, nil
		}
	}
	return 0, fmt.Errorf("journey %s has no %s step for %q", scenario.ID, strings.Join(verbs, "/"), witness.Name)
}

func assertionAfter(scenario Scenario, actionIndex int, witness Witness) (Step, int, error) {
	for index := actionIndex; index < len(scenario.Steps); index++ {
		step := scenario.Steps[index]
		if !isAssertion(step.Verb) {
			continue
		}
		// A wait for the control itself only proves it was already on screen
		// before the action; it cannot witness the action's result.
		if isSameTarget(step, witness.Name) && step.Value == "" {
			continue
		}
		if strings.EqualFold(witness.Action, "type") && !typedValueObserved(scenario, index, witness) {
			continue
		}
		return step, index + 1, nil
	}
	return Step{}, 0, fmt.Errorf("journey %s has no assertion after step %d that observes a visible result", scenario.ID, actionIndex)
}

func findAssertionAfter(scenario Scenario, actionIndex int, witness Witness) (Step, error) {
	step, _, err := assertionAfter(scenario, actionIndex, witness)
	return step, err
}

func typedValueObserved(scenario Scenario, from int, witness Witness) bool {
	for index := from; index < len(scenario.Steps); index++ {
		step := scenario.Steps[index]
		if step.Verb != "assertAccess" && step.Verb != "assertText" {
			continue
		}
		if step.Value != "" && step.Name == witness.Name {
			return true
		}
		if step.Text != "" && step.Text != witness.Name {
			return true
		}
	}
	return false
}

func isAssertion(verb string) bool {
	switch verb {
	case "waitText", "assertText", "assertNoText", "assertAccess", "assertNoAccess",
		"assertSurfaceText", "assertWindowVisible":
		return true
	}
	return false
}

func isSameTarget(step Step, name string) bool {
	return (step.Name != "" && step.Name == name) || (step.Text != "" && step.Text == name)
}

func describeAssertion(step Step) string {
	switch step.Verb {
	case "assertAccess":
		detail := "assertAccess " + quote(step.Name)
		if step.Value != "" {
			detail += " value " + quote(step.Value)
		}
		return "asserted accessibility " + detail
	case "assertWindowVisible":
		return "asserted the run's window is visible after the action"
	default:
		return step.Verb + " " + quote(firstNonEmpty(step.Text, step.Name))
	}
}

type evidenceProof struct {
	Path string
	Lane string
}

func findEvidence(evidenceRoot string, runs []string, control Control, witness Witness, actionIndex int, required []string, journeyFeature string) (evidenceProof, error) {
	candidates := []string{}
	add := func(path string) {
		for _, existing := range candidates {
			if existing == path {
				return
			}
		}
		candidates = append(candidates, path)
	}
	for _, item := range witness.Evidence {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if filepath.IsAbs(item) || strings.ContainsRune(item, os.PathSeparator) {
			add(item)
			continue
		}
		add(filepath.Join(evidenceRoot, item, featureFor(control)))
		if journeyFeature != "" {
			add(filepath.Join(evidenceRoot, item, journeyFeature))
		}
		add(filepath.Join(evidenceRoot, item))
	}
	if len(candidates) == 0 {
		// Only the runs this ledger names may prove a control. Reading the whole
		// evidence tree let an old run decide a verdict, so the tree could never be
		// cleaned without turning the audit red.
		for _, run := range runs {
			add(filepath.Join(evidenceRoot, run, featureFor(control)))
			if journeyFeature != "" {
				add(filepath.Join(evidenceRoot, run, journeyFeature))
			}
		}
	}
	reasons := []string{}
	for _, dir := range candidates {
		result, summary, err := readEvidence(dir)
		if err != nil {
			reasons = append(reasons, err.Error())
			continue
		}
		if len(result.Steps) < actionIndex {
			reasons = append(reasons, fmt.Sprintf("%s has %d recorded steps, witness is step %d", dir, len(result.Steps), actionIndex))
			continue
		}
		step := result.Steps[actionIndex-1]
		if !step.OK || step.Skipped {
			reasons = append(reasons, fmt.Sprintf("%s step %d is not a passing action (ok=%v skipped=%v)", dir, actionIndex, step.OK, step.Skipped))
			continue
		}
		if !result.OK || (summary.OK == false && result.OK == false) {
			reasons = append(reasons, fmt.Sprintf("%s is a red run; a witness cannot come from a failed journey", dir))
			continue
		}
		lane := firstNonEmpty(result.Lane, summary.Lane)
		if lane == "" {
			lane = "headless"
		}
		// A headless run cannot witness a menu, popup or focus control even
		// when it is the alphabetically first recorded run. Keep looking for
		// a run in a lane that can actually prove this control.
		if !laneAllowed(lane, required) {
			reasons = append(reasons, fmt.Sprintf("%s was driven in lane %q, but this control must be proven in %s", dir, lane, strings.Join(required, "/")))
			continue
		}
		return evidenceProof{Path: dir, Lane: lane}, nil
	}
	if len(reasons) == 0 {
		return evidenceProof{}, fmt.Errorf("no recorded evidence for %q under %s", featureFor(control), evidenceRoot)
	}
	return evidenceProof{}, fmt.Errorf("the recorded evidence does not prove step %d: %s", actionIndex, strings.Join(reasons, "; "))
}

func readEvidence(dir string) (evidenceResult, evidenceSummary, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "result.json"))
	if err != nil {
		return evidenceResult{}, evidenceSummary{}, fmt.Errorf("%s: %w", dir, err)
	}
	var result evidenceResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return evidenceResult{}, evidenceSummary{}, fmt.Errorf("%s/result.json: %w", dir, err)
	}
	var summary evidenceSummary
	if raw, err := os.ReadFile(filepath.Join(dir, "summary.json")); err == nil {
		_ = json.Unmarshal(raw, &summary)
	}
	return result, summary, nil
}

func featureFor(control Control) string {
	return firstNonEmpty(control.Feature, control.Page)
}

func requiredLanes(control Control, witness Witness) []string {
	if len(witness.Lanes) > 0 {
		return normalizeLanes(witness.Lanes)
	}
	if strings.EqualFold(control.Requires, "window") || IsMenuRole(control.Role) {
		return []string{"window", "surface"}
	}
	return nil
}

func normalizeLanes(lanes []string) []string {
	out := []string{}
	for _, lane := range lanes {
		lane = strings.ToLower(strings.TrimSpace(lane))
		if lane != "" {
			out = append(out, lane)
		}
	}
	return out
}

func laneAllowed(lane string, required []string) bool {
	if len(required) == 0 {
		return true
	}
	lane = strings.ToLower(strings.TrimSpace(lane))
	for _, want := range required {
		if lane == want {
			return true
		}
	}
	return false
}

// IsMenuRole reports whether only the real window/menu surface can expose the
// control. Headless render cannot prove a menu bar or tray item.
func IsMenuRole(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "menuitem", "menuitemcheckbox", "menuitemradio", "menu", "menubar":
		return true
	}
	return false
}

func matchWitnesses(control Control, witnesses []Witness) []int {
	indexes := []int{}
	for index, witness := range witnesses {
		if witness.Name != control.Name {
			continue
		}
		if witness.Role != "" && !strings.EqualFold(witness.Role, control.Role) {
			continue
		}
		if witness.Page != "" && !strings.EqualFold(witness.Page, control.Page) {
			continue
		}
		indexes = append(indexes, index)
	}
	return indexes
}

func matchExclusions(control Control, entries []Exclusion) []int {
	indexes := []int{}
	for index, entry := range entries {
		if entry.Name != control.Name {
			continue
		}
		if entry.Role != "" && !strings.EqualFold(entry.Role, control.Role) {
			continue
		}
		if entry.Page != "" && !strings.EqualFold(entry.Page, control.Page) {
			continue
		}
		indexes = append(indexes, index)
	}
	return indexes
}

func display(control Control) string {
	return fmt.Sprintf("%s %q (%s)", control.Role, control.Name, control.Page)
}

func keyOf(name, role, page string) string {
	return strings.TrimSpace(page) + " " + strings.ToLower(strings.TrimSpace(role)) + " " + strings.TrimSpace(name)
}

func quote(value string) string { return fmt.Sprintf("%q", value) }

func nextSuffix(next string) string {
	if strings.TrimSpace(next) == "" {
		return ""
	}
	return "; next: " + next
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
