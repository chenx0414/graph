package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

type verdictFile struct {
	Verdicts map[string]ruleVerdict `json:"verdicts"`
}

func readVerdicts(t *testing.T, root string) verdictFile {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(root, "verification", "controls", "soft-rule-verdicts.json"))
	if err != nil {
		t.Fatalf("read verdicts: %v", err)
	}
	file := verdictFile{}
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatalf("parse verdicts: %v", err)
	}
	if len(file.Verdicts) == 0 {
		t.Fatal("the verdict file names no rule")
	}
	return file
}

// Extraction alone would just be a second list that drifts. What closes the loop is that
// every extracted rule needs a verdict: what enforces it, or what records it, or why it is
// a judgement. A new soft rule therefore cannot appear without an answer.
func TestEverySoftRuleHasAVerdict(t *testing.T) {
	root := repositoryRoot(t)
	report, err := collectSoftRules(root)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	verdicts := readVerdicts(t, root)
	known := map[string]bool{}
	for name := range verdicts.Verdicts {
		known[name] = true
	}
	for _, rule := range report.Rules {
		if !known[rule.Name] {
			t.Errorf("%s (%d bytes) has no verdict: say what enforces it, or what records it, or why it is a judgement", rule.Name, rule.Size)
		}
	}
}

func TestNoVerdictOutlivesItsRule(t *testing.T) {
	root := repositoryRoot(t)
	report, err := collectSoftRules(root)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	present := map[string]bool{}
	for _, rule := range report.Rules {
		present[rule.Name] = true
	}
	verdicts := readVerdicts(t, root)
	names := make([]string, 0, len(verdicts.Verdicts))
	for name := range verdicts.Verdicts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !present[name] {
			t.Errorf("%s has a verdict but the rule is gone; delete the verdict so the file only describes what exists", name)
		}
	}
}

// A verdict has to be one of the four answers the inventory defines, and it has to carry a
// reason. 'open' is allowed and useful - it is the honest answer for a rule nothing
// enforces - but it must still say what the rule asks for.
func TestVerdictsUseTheDefinedStatesAndGiveAReason(t *testing.T) {
	root := repositoryRoot(t)
	verdicts := readVerdicts(t, root)
	allowed := map[string]bool{"hard": true, "partial": true, "open": true, "human": true, "stale": true, "duplicate": true, "foreign": true, "generated": true, "procedure": true}
	for name, verdict := range verdicts.Verdicts {
		if !allowed[verdict.State] {
			t.Errorf("%s: state %q is not one of the inventory states", name, verdict.State)
		}
		if len(verdict.Why) < 40 {
			t.Errorf("%s: the reason is too short to be a judgement, got %q", name, verdict.Why)
		}
		if verdict.State == "hard" && verdict.EnforcedBy == "" {
			t.Errorf("%s: claims a machine enforces it but never names the mechanism", name)
		}
		if verdict.State == "stale" && verdict.Evidence == "" {
			t.Errorf("%s: claims the rule is stale but gives no evidence for it", name)
		}
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	return root
}
