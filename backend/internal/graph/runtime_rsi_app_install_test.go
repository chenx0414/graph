package graph

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bundleWithExecutable(t *testing.T, root string, content string) string {
	t.Helper()
	bundle := filepath.Join(root, "dist", "app", "mac-arm64", "Graph.app")
	executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(executable, []byte(content), 0o755); err != nil {
		t.Fatalf("write built binary: %v", err)
	}
	return bundle
}

func installInto(t *testing.T, dest string, content string) {
	t.Helper()
	executable := filepath.Join(dest, "Graph.app", "Contents", "MacOS", "Graph")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(executable, []byte(content), 0o755); err != nil {
		t.Fatalf("write installed binary: %v", err)
	}
}

func TestInstallVerdictTrustsTheInstalledBinaryOverTheInstaller(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "Applications")
	bundle := bundleWithExecutable(t, root, "shell+daemon v2")
	installInto(t, dest, "shell+daemon v2")
	verdict := rsiAppInstallVerdict(bundle, dest, "installed", nil)
	if verdict.State != "installed" || !strings.Contains(verdict.Note, "Graph.app") {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestInstallVerdictReportsAFailureThatActuallyInstalled(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "Applications")
	bundle := bundleWithExecutable(t, root, "shell+daemon v2")
	installInto(t, dest, "shell+daemon v2")
	verdict := rsiAppInstallVerdict(bundle, dest, "", errors.New("codesign: something"))
	if verdict.State != "installed" || !strings.Contains(verdict.Note, "although the installer reported an error") {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestInstallVerdictRefusesAStaleInstalledBinary(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "Applications")
	bundle := bundleWithExecutable(t, root, "shell+daemon v2")
	installInto(t, dest, "shell+daemon v1")
	verdict := rsiAppInstallVerdict(bundle, dest, "installed", nil)
	if verdict.State != "failed" || !strings.Contains(verdict.Note, "does not match the built one") {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestInstallVerdictNamesBothPathsWhenNothingLanded(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "Applications")
	bundle := bundleWithExecutable(t, root, "shell+daemon v2")
	verdict := rsiAppInstallVerdict(bundle, dest, "no packaged app", errors.New("no packaged app at "+bundle))
	if verdict.State != "failed" || !strings.Contains(verdict.Note, "installed") || !strings.Contains(verdict.Note, bundle) {
		t.Fatalf("verdict = %+v", verdict)
	}
}
