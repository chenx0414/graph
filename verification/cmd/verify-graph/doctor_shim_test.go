package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The doctor's launchctl check is the safety proof for the window lane: a run
// must never be able to bootout the user's dev.graph.daemon. This test pins the
// check itself, including the detail line a human reads when it fails.
func TestDoctorProvesTheLaunchctlShimRefuses(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("/bin/sh is required to resolve launchctl through PATH")
	}
	ok, detail := proveLaunchctlShim(paths{Repo: ".", RunRoot: t.TempDir()})
	if !ok {
		t.Fatalf("the shim probe did not pass: %s", detail)
	}
	if !strings.Contains(detail, "refusing") {
		t.Fatalf("the detail must carry what the shim printed: %s", detail)
	}
	if !strings.Contains(detail, "exit 1") {
		t.Fatalf("the detail must show the shim exited non-zero: %s", detail)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(detail), "launchctl")); err == nil {
		t.Fatalf("the probe shim must be cleaned up, but %s still exists", detail)
	}
}
