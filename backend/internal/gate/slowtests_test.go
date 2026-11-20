package gate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSlowTestListMatchesTheSkips(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "backend", "slow")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := `package slow

import "testing"

func TestScale(t *testing.T) {
	if testing.Short() {
		t.Skip("scale test")
	}
}
`
	if err := os.WriteFile(filepath.Join(dir, "scale_test.go"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	found, err := SlowTests(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(found) != 1 || !strings.Contains(found[0], "TestScale") {
		t.Fatalf("the scanner must name the skipping test, got %v", found)
	}
	problems := SlowTestViolations(found, SlowTestAllowance{})
	if len(problems) != 1 {
		t.Fatalf("a skip that is not listed must be reported, got %v", problems)
	}
	listed := SlowTestAllowance{Allowed: found}
	if problems := SlowTestViolations(found, listed); len(problems) != 0 {
		t.Fatalf("a listed skip must pass, got %v", problems)
	}
	stale := SlowTestAllowance{Allowed: []string{"backend/old/gone_test.go::TestGone"}}
	problems = SlowTestViolations(found, stale)
	joined := strings.Join(problems, "\n")
	if !strings.Contains(joined, "TestGone") || !strings.Contains(joined, "remove it from the list") {
		t.Fatalf("a stale entry must be reported for removal, got %v", problems)
	}
}
