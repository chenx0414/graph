package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The three prompt constants the inventory marked stale or duplicate were dead weight: two
// were defined and never composed anywhere, and the third restated a fact the operation
// briefing already reports. Deleting them is only safe if the surface they claimed to cover
// still reports itself, so this test pins that.
func TestDeletedPromptConstantsAreNotReverted(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	path := filepath.Join(root, "backend", "internal", "graph", "runtime_agent_context.go")
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	body := string(payload)
	retired := map[string]string{
		"DEFAULT_MAIN_FULL_ACCESS_PROMPT":   "propose_system_change is not a registered tool; the constant was never composed",
		"DEFAULT_MAIN_APPROVAL_PROMPT":      "same dead pair, and the approval flow lives in runtime_system_change.go",
		"DEFAULT_MAIN_FULL_ACCESS_IDENTITY": "the access policy is a generated system prompt part, not a constant to paste",
	}
	for name, why := range retired {
		if strings.Contains(body, name) {
			t.Errorf("%s is back: %s", name, why)
		}
	}
}

// The access policy still has to reach the agent, or deleting the duplicate would remove
// the fact rather than the copy of it.
func TestAccessPolicyStillReachesThePrompt(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	path := filepath.Join(root, "backend", "internal", "graph", "runtime_agent_system_prompt.go")
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !strings.Contains(string(payload), "identity.access") {
		t.Fatal("the composed system prompt no longer has an access-policy part")
	}
}
