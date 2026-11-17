package acceptance

import (
	"os/exec"
	"strings"
	"testing"
)

func TestAccessibilityCallDetectionAcceptsLabelAndSelectedState(t *testing.T) {
	for _, call := range []string{
		`.Label("查找资源")`,
		`.Label("7 天").AccessSelected(s.insightsDays() == 7)`,
		`.Role(ui.RoleButton)`,
		`.Focusable()`,
	} {
		if !containsAccessibilityCall(call) {
			t.Fatalf("%q must count as an accessibility fix", call)
		}
	}
}

func TestAccessibilityCallDetectionRejectsProductBehavior(t *testing.T) {
	for _, call := range []string{
		"field.Grow(2).OnClick(func() { s.archive() })",
		"s.setInsightsDays(7)",
		"if err != nil { return err }",
	} {
		if containsAccessibilityCall(call) {
			t.Fatalf("%q is a product change, not an accessibility fix", call)
		}
	}
}

func TestRepositoryBoundaryIsRespected(t *testing.T) {
	repo := repoRoot(t)
	command := exec.Command("git", "-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	outside := []string{}
	for _, record := range strings.Split(string(output), "\x00") {
		if len(record) < 4 {
			continue
		}
		path := record[3:]
		if strings.HasPrefix(path, "verification/") {
			continue
		}
		// The task allows one narrow exception: a control with no stable
		// accessible name may get a minimal accessibility label/role fix in
		// app/, with an app test. Everything else outside verification/ is a
		// boundary violation.
		if strings.HasPrefix(path, "app/") && appChangeIsAccessibilityOnly(repo, path) {
			continue
		}
		outside = append(outside, record[:3]+path)
	}
	if len(outside) > 0 {
		t.Fatalf("the artifact touched files outside verification/:\n%s", strings.Join(outside, "\n"))
	}
}

// appAccessibilityFiles is the narrow, reviewable allowlist for the task's
// accessibility exception: a control without a stable accessible name may get
// a label/role fix in these files, with an app test. Adding a new product file
// here is a deliberate decision, not something a diff can earn silently.
var appAccessibilityFiles = map[string]bool{
	"app/insights_panel.go": true,
	"app/resources_page.go": true,
}

// appChangeIsAccessibilityOnly reports whether one app/ file may change: an
// app test (required to accompany the fix), or an allowlisted product file
// whose diff actually adds an accessibility attribute while an app test also
// changed. A non-allowlisted product file, or an allowlisted file with no
// accessibility call, is still a boundary violation.
func appChangeIsAccessibilityOnly(repo, path string) bool {
	trimmed := strings.TrimSpace(path)
	if !strings.HasPrefix(trimmed, "app/") || !strings.HasSuffix(trimmed, ".go") {
		return false
	}
	if strings.HasSuffix(trimmed, "_test.go") {
		return true
	}
	if !appAccessibilityFiles[trimmed] {
		return false
	}
	command := exec.Command("git", "-C", repo, "diff", "HEAD", "--no-color", "--", trimmed)
	output, err := command.Output()
	if err != nil || !containsAccessibilityCall(string(output)) {
		return false
	}
	return appTestChanged(repo)
}

// appTestChanged requires the accessibility fix to come with an app test, as
// the task says: "配 app 测试". Any modified app/*_test.go satisfies it, because
// the test names the behaviour the fix must preserve.
func appTestChanged(repo string) bool {
	command := exec.Command("git", "-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	output, err := command.Output()
	if err != nil {
		return false
	}
	for _, record := range strings.Split(string(output), "\x00") {
		if len(record) < 4 {
			continue
		}
		path := record[3:]
		if strings.HasPrefix(path, "app/") && strings.HasSuffix(path, "_test.go") {
			return true
		}
	}
	return false
}

var accessibilityCalls = []string{
	".Label(", ".AccessSelected(", ".Role(", ".Focusable(", ".Tooltip(", ".Placeholder(", ".Description(",
}

func containsAccessibilityCall(diff string) bool {
	for _, call := range accessibilityCalls {
		if strings.Contains(diff, call) {
			return true
		}
	}
	return false
}

// TestLiveRunKeepsItsEvidenceAndBlamesTheProductNotItsOwnPlumbing is the
// black-box end-to-end proof: it launches an isolated instance, runs every
// journey, then reads the evidence the run left behind. It is gated on
// VERIFY_GRAPH_LIVE=1 because it starts a real daemon.
//
// What it refuses to accept, and why:
//   - an assertion that failed because the harness could not write its own
//     evidence file ("cannot write ...") — that is a plumbing bug reported as a
//     product failure, and it must be fixed, never tolerated;
//   - evidence that does not survive cleanup, because a proof you delete is not
//     a proof;
//   - a run whose manifest no longer matches its files.
