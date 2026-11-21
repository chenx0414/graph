package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The repository is Go. A TypeScript file has no way to run here at all, and a JavaScript
// file only runs as the sandbox host for a `node` check, so both are allowed only at the two
// paths that host lives at. Everything else is a file nothing can execute, which is how
// src/runtime/module-worker.mjs kept a second copy of the machinery alive long after the
// TypeScript runtime was deleted.
func TestScriptFilesAreOnlyTheDocumentedSandboxHost(t *testing.T) {
	root := repositoryRoot(t)
	offenders, err := scanScriptFiles(root, allowedScriptFiles)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("a TypeScript or JavaScript file outside the sandbox host is code nothing can run:\n  %s", strings.Join(offenders, "\n  "))
	}
}

// The allowed list itself has to describe files that exist, otherwise a rename would leave
// the permission behind and the next .mjs would be accepted under the dead name.
func TestEveryAllowedScriptFileExists(t *testing.T) {
	root := repositoryRoot(t)
	for _, relative := range allowedScriptFiles {
		if _, err := os.Stat(filepath.Join(root, relative)); err != nil {
			t.Errorf("the allowed script file %s does not exist: %v", relative, err)
		}
	}
}

// The scan must find a file it was not told about, or it would pass on an empty repository.
func TestScriptFileScanDetectsAnOffender(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"src/accidental.ts", "src/accidental.js"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("export {}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	offenders, err := scanScriptFiles(root, nil)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(offenders) != 2 {
		t.Fatalf("the scan must report both unlisted files, got %v", offenders)
	}
}
