package graph

import (
	"strings"
	"testing"
)

func vddObligationOf(t *testing.T, role string) string {
	t.Helper()
	prompt := ComposeAgentSystemPrompt(ComposeAgentSystemPromptInput{
		Role: role, Identity: "i", RulesCommon: "c", RulesRole: "r",
	})
	for _, line := range strings.Split(prompt.Text, "\n") {
		if strings.HasPrefix(line, "VDD obligation:") {
			return line
		}
	}
	return ""
}

func TestMainWaitsForConfirmationBeforeTranslatingIntent(t *testing.T) {
	line := vddObligationOf(t, "main")
	if !strings.Contains(line, "wait for confirmation") || !strings.Contains(line, "fails on the current behaviour") {
		t.Fatalf("main must restate and wait before turning intent into checks, got %q", line)
	}
}

func TestReviewerJudgesFailabilityAndNamesEvidence(t *testing.T) {
	line := vddObligationOf(t, "reviewer")
	for _, want := range []string{"unproven rather than passed", "written after the code it tests", "exact commit"} {
		if !strings.Contains(line, want) {
			t.Fatalf("reviewer obligation must mention %q, got %q", want, line)
		}
	}
}

func TestImplementerShowsTheCheckFailingFirst(t *testing.T) {
	line := vddObligationOf(t, "worker")
	for _, want := range []string{"show it failing", "not evidence"} {
		if !strings.Contains(line, want) {
			t.Fatalf("implementer obligation must mention %q, got %q", want, line)
		}
	}
}

func TestEachRoleGetsADifferentObligation(t *testing.T) {
	seen := map[string]string{}
	for _, role := range []string{"main", "worker", "reviewer"} {
		line := vddObligationOf(t, role)
		if line == "" {
			t.Fatalf("%s has no VDD obligation", role)
		}
		if other, clash := seen[line]; clash {
			t.Fatalf("%s and %s receive the same obligation, so neither is told what proves its own work", role, other)
		}
		seen[line] = role
	}
}
