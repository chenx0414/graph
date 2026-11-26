package gate

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
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
		".run": true, // a verification run's generated prompt library is not repository prose
		// A parallel checkout keeps its own copy of the repository, including the
		// documents this gate already judged. Counting them here would report the
		// same prose twice and fail on work that belongs to that checkout.
		".worktrees": true,
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

type StagedMarkdownEntry struct {
	Path  string
	Added bool
}

func StagedMarkdown(root string) ([]StagedMarkdownEntry, error) {
	command := exec.Command("git", "status", "--porcelain=v1", "--untracked-files=all", "--", "*.md")
	command.Dir = root
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	entries := []StagedMarkdownEntry{}
	for _, line := range strings.Split(string(output), "\n") {
		if len(line) < 4 {
			continue
		}
		status := line[:2]
		path := strings.TrimSpace(line[3:])
		if !strings.HasSuffix(path, ".md") {
			continue
		}
		slashed := filepath.ToSlash(path)
		if strings.HasPrefix(slashed, ".worktrees/") {
			// Another checkout of this repository keeps its work there; it is not
			// markdown this tree is adding.
			continue
		}
		entries = append(entries, StagedMarkdownEntry{Path: slashed, Added: status == "??" || strings.Contains(status, "A")})
	}
	return entries, nil
}

func ProseExempt(path string) (bool, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(payload), "\n") {
		index := strings.Index(line, ProseExemptDirective)
		if index < 0 {
			continue
		}
		reason := line[index+len(ProseExemptDirective):]
		reason = strings.TrimSuffix(strings.TrimSpace(reason), "-->")
		reason = strings.TrimSuffix(strings.TrimSpace(reason), "*/")
		if strings.TrimSpace(reason) != "" {
			return true, nil
		}
	}
	return false, nil
}
