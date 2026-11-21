package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// A verdict that claims a machine enforces a rule has to name the machine, in a form
// something can look up. Without that, "enforcedBy" is prose too: the first census claimed
// the reviewer tool surface had no write tool and that a node carries a file list, and both
// of those were simply untrue - nothing in the repository could contradict them.
func TestEveryClaimNamesAWitnessThatExists(t *testing.T) {
	root := repositoryRoot(t)
	verdicts := readVerdicts(t, root)
	for _, name := range sortedVerdictNames(verdicts) {
		verdict := verdicts.Verdicts[name]
		claimsEnforcement := verdict.State == "hard" || verdict.State == "partial"
		if claimsEnforcement && len(verdict.Witness) == 0 {
			t.Errorf("%s: claims %s enforcement but names no witness; add the file:symbol a reader can check, or answer open", name, verdict.State)
			continue
		}
		for _, witness := range verdict.Witness {
			if problem := resolveWitness(root, witness); problem != "" {
				t.Errorf("%s: witness %q does not resolve: %s", name, witness, problem)
			}
		}
	}
}

func sortedVerdictNames(file verdictFile) []string {
	names := make([]string, 0, len(file.Verdicts))
	for name := range file.Verdicts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// resolveWitness takes "path" or "path:Symbol". The path must exist; a symbol must appear in
// that file, so a claim cannot survive a rename of the code it points at.
func resolveWitness(root string, witness string) string {
	path, symbol := witness, ""
	if at := strings.LastIndex(witness, ":"); at > 0 {
		path, symbol = witness[:at], witness[at+1:]
	}
	full := filepath.Join(root, path)
	payload, err := os.ReadFile(full)
	if err != nil {
		return "no such file " + path
	}
	if symbol == "" {
		return ""
	}
	if !strings.Contains(string(payload), symbol) {
		return path + " does not contain " + symbol
	}
	return ""
}
