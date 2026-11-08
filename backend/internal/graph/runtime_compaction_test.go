package graph

import (
	"strings"
	"testing"
)

func TestCompactionInstructionsCarryTheHandoffContractAndTheHistoryPointer(t *testing.T) {
	if !strings.Contains(COMPACTION_INSTRUCTIONS, "1500 tokens") {
		t.Fatalf("the instructions must bound the summary: %q", COMPACTION_INSTRUCTIONS)
	}
	if !strings.Contains(COMPACTION_INSTRUCTIONS, "history_search") {
		t.Fatalf("the instructions must point at the tool that reaches the full transcript: %q", COMPACTION_INSTRUCTIONS)
	}
	if !strings.Contains(COMPACTION_INSTRUCTIONS, "Do not include") {
		t.Fatalf("the instructions must forbid the leaked reply shape: %q", COMPACTION_INSTRUCTIONS)
	}
}
