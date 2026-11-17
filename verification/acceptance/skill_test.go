package acceptance

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	h2Pattern       = regexp.MustCompile(`(?m)^## (.+?)\s*$`)
	skillCommand    = regexp.MustCompile("(?:^|[^a-zA-Z-])verify-graph[ \\t]+([a-z][a-z0-9-]*)")
	requiredFeature = []string{"Sub-features", "How to get to it (user POV)", "Gotchas"}
)

func canonicalSkillRoot(t *testing.T) string {
	t.Helper()
	root := verificationRoot(t)
	skillDir := filepath.Join(root, "skill", "verify-graph", "SKILL.md")
	skillsDir := filepath.Join(root, "skills", "verify-graph", "SKILL.md")
	_, skillErr := os.Stat(skillDir)
	_, skillsErr := os.Stat(skillsDir)
	switch {
	case skillErr == nil && skillsErr == nil:
		t.Fatalf("two skill copies exist (%s and %s); the artifact must publish exactly one", skillDir, skillsDir)
	case skillsErr == nil:
		return filepath.Dir(skillsDir)
	case skillErr == nil:
		return filepath.Dir(skillDir)
	default:
		t.Fatalf("no skill/verify-graph/SKILL.md under %s", root)
	}
	return ""
}

func TestSkillTeachesEveryMappedFeature(t *testing.T) {
	skillRoot := canonicalSkillRoot(t)
	body, err := os.ReadFile(filepath.Join(skillRoot, "SKILL.md"))
	if err != nil {
		t.Fatalf("read SKILL.md: %v", err)
	}
	if len(strings.TrimSpace(string(body))) < 400 {
		t.Fatalf("SKILL.md is too short to onboard a cold agent (%d bytes)", len(body))
	}
	featuresDir := filepath.Join(skillRoot, "features")
	entries, err := os.ReadDir(featuresDir)
	if err != nil {
		t.Fatalf("skill has no features directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(featuresDir, "README.md")); err != nil {
		t.Fatalf("features/README.md (the map index) is missing")
	}
	files := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") || entry.Name() == "README.md" {
			continue
		}
		files++
		path := filepath.Join(featuresDir, entry.Name())
		payload, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(payload)
		headings := map[string]bool{}
		for _, match := range h2Pattern.FindAllStringSubmatch(text, -1) {
			headings[strings.TrimSpace(match[1])] = true
		}
		for _, required := range requiredFeature {
			if !headings[required] {
				t.Fatalf("%s misses the H2 %q; every feature file uses the same four sections", entry.Name(), required)
			}
		}
		driving := false
		for heading := range headings {
			if strings.HasPrefix(heading, "Driving it with ") {
				driving = true
			}
		}
		if !driving {
			t.Fatalf("%s misses \"Driving it with <harness>\"", entry.Name())
		}
		if !strings.Contains(text, "verify-graph ") {
			t.Fatalf("%s has no verify-graph command a reader can run", entry.Name())
		}
	}
	if files < 3 {
		t.Fatalf("the feature map covers only %d features; the app has at least 7 rail modules", files)
	}
}

func TestSkillCommandsExistInHelp(t *testing.T) {
	skillRoot := canonicalSkillRoot(t)
	help, _ := helpText(t)
	seen := map[string]bool{}
	// The cold-start skill, its control guide and the human control report are
	// all documentation a reader will paste commands from. A command that only
	// exists in prose is a broken instruction.
	paths := []string{
		filepath.Join(skillRoot, "SKILL.md"),
		filepath.Join(skillRoot, "CONTROLS.md"),
		filepath.Join(verificationRoot(t), "CONTROL_COVERAGE.md"),
	}
	featuresDir := filepath.Join(skillRoot, "features")
	entries, _ := os.ReadDir(featuresDir)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") {
			paths = append(paths, filepath.Join(featuresDir, entry.Name()))
		}
	}
	unknown := []string{}
	for _, path := range paths {
		payload, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, match := range skillCommand.FindAllStringSubmatch(string(payload), -1) {
			name := match[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			if !strings.Contains(help, name) {
				unknown = append(unknown, name+" ("+filepath.Base(path)+")")
			}
		}
	}
	if len(unknown) > 0 {
		t.Fatalf("skill documents commands the CLI does not list: %s", strings.Join(unknown, ", "))
	}
}
