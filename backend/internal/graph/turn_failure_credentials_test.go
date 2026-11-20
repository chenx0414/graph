package graph

import (
	"strings"
	"testing"
)

func TestAMissingCredentialPointsAtTheProvidersPageInsteadOfRetrying(t *testing.T) {
	for _, reason := range []string{
		"No credential bound for model opencode-go:deepseek-v4-flash",
		"No configured model for a master agent",
	} {
		text := TurnFailureText(reason, TurnFailureSetup)
		if strings.Contains(text, "可以再发一次重试") {
			t.Fatalf("%q tells the user to retry a turn that cannot succeed: %q", reason, text)
		}
		if !strings.Contains(text, "供应商") {
			t.Fatalf("%q points at the providers page: %q", reason, text)
		}
	}
}

func TestAnOrdinarySetupFailureStillOffersARetry(t *testing.T) {
	text := TurnFailureText("the kernel refused to open the turn", TurnFailureSetup)
	if !strings.Contains(text, "可以再发一次重试") {
		t.Fatalf("a failure the user can retry still says so: %q", text)
	}
}
