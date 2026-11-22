package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Documentation that tells someone to run a script the repository no longer has sends them into
// a command that cannot work. install-check-policy.py was deleted with package.json, which it
// read, and the guide went on telling people to run it.
func TestDocumentationNamesNoDeletedScript(t *testing.T) {
	root := repositoryRoot(t)
	gone := []string{"install-check-policy.py", "node --run check"}
	offenders := []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, incoming error) error {
		if incoming != nil {
			return incoming
		}
		name := entry.Name()
		if entry.IsDir() {
			if scriptFileSkippedDirs[name] || name == "state" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".md") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		for _, reference := range gone {
			if strings.Contains(string(content), reference) {
				offenders = append(offenders, filepath.ToSlash(relative)+" names "+reference)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the documentation: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("the documentation sends people to something that does not exist:\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

// The script itself has to be gone, and nothing may still call it.
func TestTheDeadCheckPolicyScriptIsGone(t *testing.T) {
	root := repositoryRoot(t)
	if _, err := os.Stat(filepath.Join(root, "scripts", "install-check-policy.py")); err == nil {
		t.Fatalf("install-check-policy.py reads package.json, which this repository no longer has")
	}
}
