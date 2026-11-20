package gate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryDoesNotReferenceRetiredIndexTools(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	retired := []string{"codegraph"}
	skipped := map[string]bool{"node_modules": true, "dist": true, ".git": true, ".emergence": true, "coordination": true}
	counted := 0
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if skipped[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".md") && !strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".json") && !strings.HasSuffix(path, ".yml") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		counted++
		lower := strings.ToLower(string(payload))
		for _, name := range retired {
			if strings.Contains(lower, name) {
				relative, _ := filepath.Rel(root, path)
				t.Errorf("%s still references the retired tool %q", relative, name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk repository: %v", err)
	}
	if counted == 0 {
		t.Fatalf("no file counted under %s", root)
	}
}
