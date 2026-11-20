package gate

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A specification is a decision record, not a rule: the behaviour it describes is enforced
// by tests and gates. What stays in the repository is the spec that the running product
// contract still points at; one that nothing references is a memory, and a memory in a
// specification directory is indistinguishable from a claim about the present.
func TestSpecificationsAreReferencedOrGone(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	specDir := filepath.Join(root, "docs", "specs")
	entries, err := os.ReadDir(specDir)
	if err != nil {
		t.Fatalf("read %s: %v", specDir, err)
	}
	specs := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		specs = append(specs, entry.Name())
	}
	referenced := map[string]bool{}
	skipped := map[string]bool{"node_modules": true, "dist": true, ".git": true, ".emergence": true, "coordination": true, "testdata": true}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if skipped[entry.Name()] || entry.Name() == ".agents" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") || !isTextSource(entry.Name()) {
			return nil
		}
		if strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		text := string(payload)
		for _, spec := range specs {
			if strings.Contains(text, spec) {
				referenced[spec] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk repository: %v", err)
	}
	for _, spec := range specs {
		if !referenced[spec] {
			t.Errorf("docs/specs/%s is referenced by nothing: a specification that the product no longer points at is a claim about the past", spec)
		}
	}
}

func isTextSource(name string) bool {
	for _, suffix := range []string{".md", ".go", ".json", ".yml", ".yaml", ".py"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}
