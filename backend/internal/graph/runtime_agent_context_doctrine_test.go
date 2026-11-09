package graph

import (
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
		"reuse":      "R30 Reuse first",
		"verifiable": "R31 Verifiability first",
		"minimal":    "R32 Minimal stable path",
		"removal":    "R33 Removal is complete",
		"test order": "R34 Test order: unit, integration and E2E are all allowed",
		"comments":   "R35 Comments are not documentation",
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
