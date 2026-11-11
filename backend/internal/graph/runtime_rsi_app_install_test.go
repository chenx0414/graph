package graph

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeBundle(t *testing.T, bundle, identifier, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	if err := os.WriteFile(executable, []byte("shell+daemon"), 0o755); err != nil {
		t.Fatalf("write executable: %v", err)
	}
	plist := "" +
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
		"<plist version=\"1.0\"><dict>" +
		"<key>CFBundleIdentifier</key><string>" + identifier + "</string>" +
		"<key>CFBundleShortVersionString</key><string>" + version + "</string>" +
		"</dict></plist>\n"
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatalf("write plist: %v", err)
	}
}

func builtBundle(t *testing.T) string {
	t.Helper()
	bundle := filepath.Join(t.TempDir(), "dist", "app", "mac-arm64", "Graph.app")
	writeBundle(t, bundle, "dev.graph.console", "0.2.0")
	return bundle
}

func destination(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "Applications", "Graph.app")
}

func TestInstallVerdictAcceptsTheSameIdentityEvenThoughSigningChangesBytes(t *testing.T) {
	bundle := builtBundle(t)
	dest := destination(t)
	writeBundle(t, dest, "dev.graph.console", "0.2.0")
	verdict := rsiAppInstallVerdict(bundle, dest, "installed", nil)
	if verdict.State != "installed" || !strings.Contains(verdict.Note, "dev.graph.console@0.2.0") {
		t.Fatalf("verdict = %+v", verdict)
	}
	if !strings.Contains(verdict.Note, "signature") {
		t.Fatalf("the note must say whether the signature verified: %+v", verdict)
	}
}

func TestInstallVerdictRefusesAnotherBuildAtTheDestination(t *testing.T) {
	bundle := builtBundle(t)
	dest := destination(t)
	writeBundle(t, dest, "dev.graph.console", "0.1.0")
	verdict := rsiAppInstallVerdict(bundle, dest, "installed", nil)
	if verdict.State != "failed" || !strings.Contains(verdict.Note, "not the build that was made") {
		t.Fatalf("verdict = %+v", verdict)
	}
	if !strings.Contains(verdict.Note, "0.2.0") || !strings.Contains(verdict.Note, "0.1.0") {
		t.Fatalf("the note must name both identities: %+v", verdict)
	}
}

func TestInstallVerdictReportsAnInstallThatFailedAndLanded(t *testing.T) {
	bundle := builtBundle(t)
	dest := destination(t)
	writeBundle(t, dest, "dev.graph.console", "0.2.0")
	verdict := rsiAppInstallVerdict(bundle, dest, "", errors.New("codesign: something"))
	if verdict.State != "installed" || !strings.Contains(verdict.Note, "although the installer reported an error") {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestInstallVerdictNamesBothBundlesWhenNothingLanded(t *testing.T) {
	bundle := builtBundle(t)
	dest := destination(t)
	verdict := rsiAppInstallVerdict(bundle, dest, "no packaged app", errors.New("no packaged app at "+bundle))
	if verdict.State != "failed" || !strings.Contains(verdict.Note, bundle) || !strings.Contains(verdict.Note, dest) {
		t.Fatalf("verdict = %+v", verdict)
	}
}
