package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func TestAWrittenJourneyResultCarriesTheBudgetDirectiveAndStaysReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "result.json")
	original := map[string]any{
		"ok": true, "lane": "window",
		"steps": []any{map[string]any{"index": 1, "verb": "click", "ok": true}},
		"texts": []any{"白板标题", "洞察"},
	}
	raw, err := json.MarshalIndent(original, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	markEvidenceFile(path)
	reRead, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var marked map[string]any
	if err := json.Unmarshal(reRead, &marked); err != nil {
		t.Fatalf("a marked result must stay valid JSON: %v", err)
	}
	marker, _ := marked["_graph"].(string)
	if !strings.Contains(marker, "graph:allow-large-file:") || !strings.Contains(marker, "journey evidence") {
		t.Fatalf("a journey result must carry its own budget directive, got %q", marker)
	}
	if marked["ok"] != true || marked["lane"] != "window" {
		t.Fatalf("marking must not drop the evidence fields: %+v", marked)
	}
}
