package gate

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const ProseExemptDirective = "graph:allow-prose:"

type ProseAllowance struct {
	Allowed []string `json:"allowed"`
}

type proseScan struct {
	Path    string
	Exempt  string
	Tracked bool
}

func ScanProse(root string) ([]string, error) {
	skipped := map[string]bool{
		"node_modules": true, "dist": true, "build": true, "out": true,
		"vendor": true, "coverage": true, "target": true, ".git": true,
		".emergence": true, "coordination": true, "state": true,
	}
	found := []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if skipped[entry.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".md") {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if allowed, _ := DocumentationAllowed(relative); allowed {
			return nil
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for _, line := range strings.Split(string(payload), "\n") {
			if index := strings.Index(line, ProseExemptDirective); index >= 0 {
				reason := line[index+len(ProseExemptDirective):]
				reason = strings.TrimSuffix(strings.TrimSpace(reason), "-->")
				reason = strings.TrimSuffix(strings.TrimSpace(reason), "*/")
				if strings.TrimSpace(reason) != "" {
					return nil
				}
			}
		}
		found = append(found, relative)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return found, nil
}

func ProseViolations(found []string, allowance ProseAllowance) []string {
	allowed := map[string]bool{}
	for _, path := range allowance.Allowed {
		allowed[path] = true
	}
	present := map[string]bool{}
	problems := []string{}
	for _, path := range found {
		present[path] = true
		if !allowed[path] {
			problems = append(problems, path+": this prose is new; convert it or exempt it with "+ProseExemptDirective+" <reason>")
		}
	}
	for _, path := range allowance.Allowed {
		if !present[path] {
			problems = append(problems, path+": listed in the baseline but no longer exists; delete its entry so the budget only shrinks")
		}
	}
	return problems
}

func ParseProseAllowance(payload []byte, allowance *ProseAllowance) error {
	if err := json.Unmarshal(payload, allowance); err != nil {
		return err
	}
	if allowance.Allowed == nil {
		allowance.Allowed = []string{}
	}
	return nil
}

func WriteProseAllowance(path string, found []string) error {
	sorted := append([]string{}, found...)
	sortStrings(sorted)
	payload, err := json.MarshalIndent(ProseAllowance{Allowed: sorted}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o644)
}

func sortStrings(items []string) {
	for index := 1; index < len(items); index++ {
		for back := index; back > 0 && items[back] < items[back-1]; back-- {
			items[back], items[back-1] = items[back-1], items[back]
		}
	}
}

var _ = fmt.Sprintf
