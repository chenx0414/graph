package gate

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var markdownLinkTarget = regexp.MustCompile(`\]\(([^)\s]+)\)`)

func TestDocumentationLinksResolve(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	skipped := map[string]bool{
		"node_modules": true, "dist": true, "build": true, "out": true,
		"vendor": true, "coverage": true, "target": true, ".git": true,
		".emergence": true,
	}
	counted := 0
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
		if !strings.HasSuffix(path, ".md") {
			return nil
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		counted++
		for _, match := range markdownLinkTarget.FindAllStringSubmatch(string(payload), -1) {
			target := match[1]
			if strings.Contains(target, "://") || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "mailto:") {
				continue
			}
			if index := strings.IndexAny(target, "#?"); index >= 0 {
				target = target[:index]
			}
			if target == "" {
				continue
			}
			resolved := target
			if !filepath.IsAbs(target) {
				resolved = filepath.Join(filepath.Dir(path), target)
			}
			if _, statErr := os.Stat(resolved); statErr != nil {
				relative, _ := filepath.Rel(root, path)
				t.Errorf("%s: link target %q does not exist", relative, match[1])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk repository: %v", err)
	}
	if counted == 0 {
		t.Fatalf("no markdown found under %s", root)
	}
}
