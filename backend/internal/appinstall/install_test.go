package appinstall

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, directory, name, content string) string {
	t.Helper()
	full := filepath.Join(directory, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return full
}

func fakeBundle(t *testing.T, root string) string {
	t.Helper()
	bundle := filepath.Join(root, "dist", "app", "mac-arm64", "Graph.app")
	write(t, bundle, "Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.graph.console</string>
<key>CFBundleExecutable</key><string>Graph</string>
</dict></plist>`)
	payload, err := os.ReadFile("/bin/echo")
	if err != nil {
		t.Fatal(err)
	}
	write(t, bundle, "Contents/MacOS/Graph", string(payload))
	return bundle
}

func toolsAvailable(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"codesign", "security", "openssl", "plutil"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " is not available in this environment")
		}
	}
}

func TestStalePackageComparesTheShellSourcesWithTheBinary(t *testing.T) {
	root := t.TempDir()
	bundle := fakeBundle(t, root)
	write(t, root, "app/mygo.json", `{"identifier":"dev.graph.console"}`)
	write(t, root, "app/main.go", "package main\n")
	old := time.Now().Add(-time.Hour)
	for _, name := range []string{"main.go", "mygo.json"} {
		if err := os.Chtimes(filepath.Join(root, "app", name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if name, stale := StalePackage(root, bundle); stale {
		t.Fatalf("a package built after its sources is not stale, got %q", name)
	}
	fresh := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(root, "app", "main.go"), fresh, fresh); err != nil {
		t.Fatal(err)
	}
	name, stale := StalePackage(root, bundle)
	if !stale || name != "main.go" {
		t.Fatalf("a source newer than the package must be reported, got %q %v", name, stale)
	}
}

func TestInstallRefusesAPackageWhoseSourcesMoved(t *testing.T) {
	toolsAvailable(t)
	root := t.TempDir()
	bundle := fakeBundle(t, root)
	write(t, root, "app/mygo.json", `{"identifier":"dev.graph.console"}`)
	source := write(t, root, "app/main.go", "package main\n")
	fresh := time.Now().Add(time.Hour)
	if err := os.Chtimes(source, fresh, fresh); err != nil {
		t.Fatal(err)
	}
	_, err := Install(InstallOptions{Root: root, Bundle: bundle, Dest: filepath.Join(root, "Applications", "Graph.app")})
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != ExitStale {
		t.Fatalf("a stale package must exit %d, got %v", ExitStale, err)
	}
	if !strings.Contains(err.Error(), "graphbuild app") {
		t.Fatalf("the refusal must name the command that rebuilds it, got %q", err.Error())
	}
}

func TestInstallDryRunTouchesNothing(t *testing.T) {
	toolsAvailable(t)
	root := t.TempDir()
	bundle := fakeBundle(t, root)
	dest := filepath.Join(root, "Applications", "Graph.app")
	message, err := Install(InstallOptions{Root: root, Bundle: bundle, Dest: dest, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(message, "would install") {
		t.Fatalf("a dry run says what it would do, got %q", message)
	}
	if _, statErr := os.Stat(dest); statErr == nil {
		t.Fatal("a dry run must not write the destination")
	}
}

func TestInstallSignsWithTheStableIdentityAndKeepsThePreviousCopy(t *testing.T) {
	toolsAvailable(t)
	root := t.TempDir()
	bundle := fakeBundle(t, root)
	dest := filepath.Join(root, "Applications", "Graph.app")
	if _, err := Install(InstallOptions{Root: root, Bundle: bundle, Dest: dest}); err != nil {
		t.Fatalf("the first install must succeed: %v", err)
	}
	requirement, err := DesignatedRequirement(filepath.Join(dest, "Contents", "MacOS", "Graph"))
	if err != nil {
		t.Fatal(err)
	}
	if !SignatureIsStable(requirement) {
		t.Fatalf("the installed binary must carry the stable requirement, got %q", requirement)
	}
	if _, err := Install(InstallOptions{Root: root, Bundle: bundle, Dest: dest}); err != nil {
		t.Fatalf("the second install must succeed: %v", err)
	}
	if _, statErr := os.Stat(dest + ".previous"); statErr != nil {
		t.Fatalf("the replaced copy must be kept for rollback: %v", statErr)
	}
}

func TestSignatureIsStableReadsTheRequirement(t *testing.T) {
	for _, test := range []struct {
		requirement string
		stable      bool
	}{
		{`designated => identifier "dev.graph.console" and certificate root = H"abc"`, true},
		{`designated => cdhash H"f999"`, false},
		{`designated => identifier "x"`, false},
	} {
		if got := SignatureIsStable(test.requirement); got != test.stable {
			t.Fatalf("%q -> %v, want %v", test.requirement, got, test.stable)
		}
	}
}

func TestVerifyInstalledRefusesACopyWithoutAnExecutable(t *testing.T) {
	dest := t.TempDir()
	if err := verifyInstalled(dest); err == nil {
		t.Fatal("a destination with no executable was accepted")
	} else if !strings.Contains(strings.ToLower(err.Error()), "executable") {
		t.Fatalf("the error must name the missing executable: %v", err)
	}
	executable := filepath.Join(dest, "Contents", "MacOS", "Graph")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := verifyInstalled(dest); err == nil {
		t.Fatal("an executable without the execute bit was accepted")
	}
	if err := os.Chmod(executable, 0o755); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if err := verifyInstalled(dest); err != nil {
		t.Fatalf("a real executable was refused: %v", err)
	}
}
