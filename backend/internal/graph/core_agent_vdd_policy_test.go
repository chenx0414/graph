package graph

import (
	"strings"
	"testing"
)

func TestEveryAgentRoleStatesWhatProvesItsWork(t *testing.T) {
	for _, role := range []struct {
		role, obligation string
	}{
		{role: "main", obligation: "wait for confirmation"},
		{role: "worker", obligation: "before the code"},
		{role: "reviewer", obligation: "never seen fail"},
	} {
		prompt := ComposeAgentSystemPrompt(ComposeAgentSystemPromptInput{
			Role: role.role, Identity: "identity", RulesCommon: "common", RulesRole: "role",
		})
		if !strings.Contains(strings.ToLower(prompt.Text), strings.ToLower(role.obligation)) {
			t.Errorf("%s must state its VDD obligation (%q)", role.role, role.obligation)
		}
	}
}

func TestReviewerStatesTheFailabilityObligation(t *testing.T) {
	prompt := ComposeAgentSystemPrompt(ComposeAgentSystemPromptInput{
		Role: "reviewer", Identity: "identity", RulesCommon: "common", RulesRole: "role",
	})
	lower := strings.ToLower(prompt.Text)
	for _, want := range []string{"never seen fail", "before the code"} {
		if !strings.Contains(lower, want) {
			t.Errorf("a reviewer must judge failability (%q missing)", want)
		}
	}
}
