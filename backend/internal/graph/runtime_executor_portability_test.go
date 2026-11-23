package graph

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTheExecutorRunsOnEveryHostItIsBuiltFor(t *testing.T) {
	workspace := t.TempDir()
	runner := OpenWorkspaceCommandRunner(workspace, filepath.Join(workspace, "scratch"), SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 30_000)
	defer runner.Close()
	result := runner.Run("/bin/sh", []string{"-c", "printf %s " + runtime.GOOS + "; exit 0"}, nil)
	if result.Code == nil {
		t.Fatalf("the executor returned no exit code on %s: %q", runtime.GOOS, result.Stderr)
	}
	if *result.Code != 0 {
		t.Fatalf("the executor failed on %s: code %d stderr %q", runtime.GOOS, *result.Code, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != runtime.GOOS {
		t.Fatalf("the command did not report %s: %q", runtime.GOOS, result.Stdout)
	}
}
