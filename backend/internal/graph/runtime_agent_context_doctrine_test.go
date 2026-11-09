package graph

import (
	"regexp"
	"strings"
	"testing"
)

func TestShippedRulesCarryEveryWorkingDoctrine(t *testing.T) {
	library := NewAgentContextLibrary(t.TempDir(), AgentContextDefaults{})
	common, err := library.Prompt("rules/common.md")
	if err != nil {
		t.Fatalf("common rules: %v", err)
	}
	doctrines := map[string]string{
		"reuse":      "Prefer an existing implementation over a new one",
		"verifiable": "Make every change verifiable",
		"minimal":    "Take the smallest implementation",
		"removal":    "Delete completely when a feature goes",
		"test order": "Write the test before the code",
		"comments":   "Keep comments to machine directives",
	}
	for name, marker := range doctrines {
		if !strings.Contains(common, marker) {
			t.Errorf("common rules miss the %s doctrine: %q", name, marker)
		}
	}
	reviewer, err := library.Prompt("rules/reviewer.md")
	if err != nil {
		t.Fatalf("reviewer rules: %v", err)
	}
	for _, marker := range []string{"duplicate path", "incomplete removal", "unverifiable change", "explanatory comment"} {
		if !strings.Contains(reviewer, marker) {
			t.Errorf("reviewer rules do not name %q as a defect", marker)
		}
	}
}

func TestShippedRulesUseNoRuleNumbers(t *testing.T) {
	library := NewAgentContextLibrary(t.TempDir(), AgentContextDefaults{})
	numbered := regexp.MustCompile(`(?m)^-\s*R\d+`)
	for _, key := range []AgentPromptKey{"rules/common.md", "rules/main.md", "rules/worker.md", "rules/reviewer.md"} {
		text, err := library.Prompt(key)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if match := numbered.FindString(text); match != "" {
			t.Errorf("%s still starts a rule with a rule number: %q", key, match)
		}
	}
}
