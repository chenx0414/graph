package graph

import (
	"strings"
	"testing"
)

// A check acceptance that names implementation nodes is the one place a graph promises that
// its work was proven by a check that can fail. Without `verification` the graph says only
// "run this and tell me if it passed", which a check that has never failed also satisfies -
// the verification this repository is built around cannot be opted out of by leaving a field
// blank.
func TestACheckAcceptanceWithImplementersMustDeclareVerification(t *testing.T) {
	proposal := acceptanceTestProposal(map[string]any{"omit": true})

	deferred := func() (outcome any) {
		defer func() { outcome = recover() }()
		ValidateProposal(proposal)
		return nil
	}()
	if deferred == nil {
		t.Fatal("a check acceptance naming implementation nodes must declare verification")
	}
	message := panicMessage(deferred)
	if !strings.Contains(message, "verification") {
		t.Fatalf("the refusal must name the missing verification, got %q", message)
	}
}

// A check with no implementation node in the graph judges something the graph did not build
// (a repository command, an environment probe), so there is no baseline to require.
func TestACheckAcceptanceWithoutImplementersNeedsNoVerification(t *testing.T) {
	proposal := acceptanceTestProposal(map[string]any{})
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("a check with no implementation node must still be proposable: %v", panicMessage(recovered))
		}
	}()
	ValidateProposal(proposal)
}

func acceptanceTestProposal(implementationNodes map[string]any) map[string]any {
	verification := map[string]any{"paths": []any{"verify.sh"}, "failureText": "wanted the new value"}
	omit := implementationNodes != nil && implementationNodes["omit"] == true
	if implementationNodes != nil {
		if nodes, ok := implementationNodes["nodes"]; ok {
			verification["implementationNodes"] = nodes
		}
	}
	acceptance := map[string]any{
		"id": "behavior", "description": "Read the new value", "kind": "check", "module": "check",
	}
	if !omit {
		acceptance["verification"] = verification
	}
	definition := map[string]any{
		"schemaVersion": 2, "name": "Acceptance gate", "protocols": map[string]any{"data": map[string]any{"type": "object"}},
		"nodes": map[string]any{"implement": map[string]any{
			"recipe": "coder@1", "task": "Set product.txt to new",
			"inputs": map[string]any{}, "outputs": map[string]any{}, "submission": map[string]any{},
		}}, "edges": map[string]any{},
		"inputs":  map[string]any{"verify": map[string]any{"to": "check.job", "protocol": "data"}},
		"outputs": map[string]any{},
		"modules": map[string]any{"check": map[string]any{
			"type": "operation", "trigger": "each",
			"inputs":  map[string]any{"job": map[string]any{"protocol": "data"}},
			"outputs": map[string]any{"result": map[string]any{"protocol": "data"}},
			"operation": map[string]any{
				"action": "workspace.command", "version": 1, "command": "sh", "args": []any{"verify.sh"}, "output": "result", "sandbox": false,
			},
		}},
		"acceptance": []any{acceptance},
	}
	mirror := map[string]any{}
	for key, value := range acceptance {
		mirror[key] = value
	}
	mirror["checkNode"] = "check"
	return map[string]any{"requirementVersion": 1, "summary": "prove the work", "definition": definition, "acceptance": []any{mirror}}
}
