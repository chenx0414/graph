package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// maxCheckEvidenceBytes is the gate budget expressed in bytes (5000 tokens at
// 4 bytes per token). It is only used to make the fixture test meaningful.
const maxCheckEvidenceBytes = 5000 * 4

func TestASmallCheckBodyIsStoredVerbatim(t *testing.T) {
	document := checkEvidence(apiCheck{ID: "health", Method: "GET", Path: "/api/health"}, 200, map[string]any{"ok": true})
	body, ok := document["body"].(map[string]any)
	if !ok || body["ok"] != true {
		t.Fatalf("a small body must be kept whole: %+v", document)
	}
	if _, elided := document["bodySha256"]; elided {
		t.Fatalf("a small body must not be elided: %+v", document)
	}
}

// TestALargeCheckBodyStaysVerbatimBehindTheBudgetDirective pins the evidence
// rule: a check response is the proof, so it is never replaced by a digest.
// The repository's own gate accepts the file because the `_graph` marker names
// the reason (backend/internal/gate reads the same marker).
func TestALargeCheckBodyStaysVerbatimBehindTheBudgetDirective(t *testing.T) {
	large := map[string]any{
		"prompts": []any{strings.Repeat("系统提示", 4000)},
		"tools":   []any{strings.Repeat("tool", 4000)},
		"mode":    "view",
	}
	document := checkEvidence(apiCheck{ID: "context", Method: "GET", Path: "/api/agent-context"}, 200, large)
	if _, kept := document["body"]; !kept {
		t.Fatal("the response body is the evidence and must be stored whole")
	}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= maxCheckEvidenceBytes {
		t.Fatalf("this fixture must exceed the budget to exercise the directive: %d bytes", len(raw))
	}
	marker, _ := document["_graph"].(string)
	if !strings.Contains(marker, "graph:allow-large-file:") {
		t.Fatalf("a large evidence file must carry the gate directive, got %q", marker)
	}
	if !strings.Contains(marker, "raw daemon response kept as evidence") {
		t.Fatalf("the directive must say why the file cannot be split: %q", marker)
	}
}
