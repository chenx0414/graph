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

func TestComposedRulesDoNotContradictEachOther(t *testing.T) {
	library := NewAgentContextLibrary(t.TempDir(), AgentContextDefaults{})
	main, err := library.Prompt("tools/main.md")
	if err != nil {
		t.Fatalf("main tools: %v", err)
	}
	worker, err := library.Prompt("rules/worker.md")
	if err != nil {
		t.Fatalf("worker rules: %v", err)
	}
	common, err := library.Prompt("rules/common.md")
	if err != nil {
		t.Fatalf("common rules: %v", err)
	}
	if strings.Count(main, "SKILL.md") != 1 {
		t.Errorf("the skills rule must be stated once in the main guidance, found %d", strings.Count(main, "SKILL.md"))
	}
	if strings.Contains(main, "not background reading") {
		t.Error("the skills rule both calls skills background reading it never does and commands reading them first")
	}
	for _, marker := range []string{"get_task_status", "get_graph_state", "do not poll"} {
		if !strings.Contains(main, marker) {
			t.Errorf("the state-read rule leaves %q unsaid, so it contradicts the no-poll rule after activation", marker)
		}
	}
	if strings.Contains(worker, "never substitute a pure-logic unit or integration test") {
		t.Error("worker rules forbid unit and integration tests while the shared rules allow them at their own level")
	}
	if strings.Contains(common, "only author E2E tests") || strings.Contains(common, "never write unit or integration tests") {
		t.Error("common rules forbid the test levels the host policy allows")
	}
	for _, marker := range []string{"Choose the test level highest first", "a module or component test of its outward behaviour"} {
		if !strings.Contains(common+"\n"+worker, marker) {
			t.Errorf("the test-level rule is missing %q", marker)
		}
	}
	mainRules, err := library.Prompt("rules/main.md")
	if err != nil {
		t.Fatalf("main rules: %v", err)
	}
	if strings.Contains(mainRules, "full host gate") {
		t.Error("main rules demand the full host gate, while activation runs the fast layer and the full suite confirms after the reload")
	}
	if strings.Contains(mainRules, "merge into the application main line") {
		t.Error("main rules ask for a main-line merge, while a change lands as an rsi commit that activation reloads")
	}
}
