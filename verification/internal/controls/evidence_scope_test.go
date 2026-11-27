package controls

import (
	"os"
	"path/filepath"
	"testing"
)

// --- evidence scope -------------------------------------------------------

// auditWritesRun records a green journey run under evidenceRoot/run, with the steps
// the F-02 journey needs: a run that cannot prove the control is no use here.
func auditWritesRun(t *testing.T, f fixture, run, feature string) {
	t.Helper()
	writeEvidence(t, f, run, feature, "headless", true, []evidenceStep{
		{Index: 1, Verb: "waitText", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "waitText", OK: true},
	})
}

// The audit used to read every directory under verification/evidence, so an old
// run that no ledger row names still decided whether a control passed — and
// deleting it turned the audit red. Only a run the ledger names may decide.
func TestAnUnreferencedRunDoesNotDecideTheAudit(t *testing.T) {
	f := newFixture(t)

	// One run the ledger names, one it does not, both claiming the same control.
	auditWritesRun(t, f, "kept-run", "F-02")
	auditWritesRun(t, f, "stale-run", "F-02")

	controls := []Control{{Name: "洞察", Role: "button", Page: "rail"}}
	witness := Witness{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"}
	withKept := runAudit(t, f, controls, Ledger{EvidenceRuns: []string{"kept-run"}, Witnesses: []Witness{witness}})
	if len(withKept.Problems) != 0 {
		t.Fatalf("the named run proves the control: %+v", withKept.Problems)
	}

	// A ledger that names nothing must not be rescued by a run it never mentions.
	// This is the failure the tree-wide scan caused: the stale run made the audit
	// green, so deleting it turned the audit red.
	unnamed := runAudit(t, f, controls, Ledger{EvidenceRuns: []string{"other-run"}, Witnesses: []Witness{witness}})
	if len(unnamed.Problems) == 0 {
		t.Fatal("a run the ledger does not name must not prove the control")
	}

	// Deleting the unreferenced run leaves the audit exactly as it was.
	if err := os.RemoveAll(filepath.Join(f.evidence, "stale-run")); err != nil {
		t.Fatal(err)
	}
	after := runAudit(t, f, controls, Ledger{EvidenceRuns: []string{"kept-run"}, Witnesses: []Witness{witness}})
	if len(after.Problems) != len(withKept.Problems) {
		t.Fatalf("removing an unreferenced run changed the audit: %d vs %d problems",
			len(after.Problems), len(withKept.Problems))
	}
}

// A run the ledger names must still exist and be fresh: scoping the source must
// not become a way to pass with nothing behind it.
func TestAMissingReferencedRunStillFails(t *testing.T) {
	f := newFixture(t)
	controls := []Control{{Name: "洞察", Role: "button", Page: "rail"}}
	report := runAudit(t, f, controls, Ledger{EvidenceRuns: []string{"gone-run"}})
	if len(report.Problems) == 0 {
		t.Fatal("a ledger that names a missing run must not pass")
	}
}
