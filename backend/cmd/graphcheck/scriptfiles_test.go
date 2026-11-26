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

// One sandbox host script, one copy. src/runtime/ held a second copy of both files and the
// checker had to permit each half separately; the copies were byte-identical, so keeping two
// only left a way for them to drift apart unnoticed.
func TestTheSandboxHostExistsInExactlyOnePlace(t *testing.T) {
	root := repositoryRoot(t)
	for _, name := range []string{"module-worker.mjs", "check-resolver.cjs"} {
		copies := []string{}
		for _, directory := range []string{"src/runtime", "backend/internal/graph/embedded/runtime"} {
			path := filepath.Join(root, directory, name)
			if _, err := os.Stat(path); err == nil {
				copies = append(copies, filepath.ToSlash(filepath.Join(directory, name)))
			}
		}
		if len(copies) != 1 {
			t.Fatalf("%s must exist in exactly one place, found %d: %v", name, len(copies), copies)
		}
		if copies[0] != filepath.ToSlash(filepath.Join("backend/internal/graph/embedded/runtime", name)) {
			t.Fatalf("%s must be the embedded copy the binary ships, found %s", name, copies[0])
		}
	}
}

// A verification run keeps its own copy of the app inside verification/.run/,
// assets included. That tree is git-ignored and generated, so it is not source
// the repository owns: scanning it made the gate fail on a machine that had
// driven the interface, and pass on one that had not.
func TestAGeneratedRunTreeIsNotSourceCode(t *testing.T) {
	root := t.TempDir()
	generated := filepath.Join(root, "verification", ".run", "7cd8575b", "graph-home", "assets", "runtime")
	if err := os.MkdirAll(generated, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"check-resolver.cjs", "module-worker.mjs"} {
		if err := os.WriteFile(filepath.Join(generated, name), []byte("export {}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	offenders, err := scanScriptFiles(root, nil)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(offenders) != 0 {
		t.Fatalf("a generated run tree is not repository source, got %v", offenders)
	}
}

// The scan still has to read a .gitignore'd path that is not a run tree: only the
// generated run root is exempt, not everything a project refuses to commit.
func TestAnIgnoredSourceFileIsStillReported(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scratch"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("scratch/\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scratch", "accidental.ts"), []byte("export {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	offenders, err := scanScriptFiles(root, nil)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(offenders) != 1 {
		t.Fatalf("only the generated run tree is exempt, got %v", offenders)
	}
}
