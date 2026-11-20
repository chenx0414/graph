package acceptance

import (
	"encoding/json"
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

// A feature is its executable scenario. The skill has to teach the command that runs a
// scenario and to name every feature the index maps, but the steps themselves live in
// the scenario JSON, where running them proves them.
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
	payload, err := os.ReadFile(filepath.Join(featuresDir, "index.json"))
	if err != nil {
		t.Fatalf("the feature index is the map: %v", err)
	}
	index := struct {
		Features []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Scenario string `json:"scenario"`
			Drive    []string `json:"drive"`
		} `json:"features"`
	}{}
	if err := json.Unmarshal(payload, &index); err != nil {
		t.Fatalf("parse features/index.json: %v", err)
	}
	if len(index.Features) == 0 {
		t.Fatalf("%s maps no feature", featuresDir)
	}
	text := string(body)
	for _, want := range []string{"features/index.json", "FEATURE_MAP.md", "verify --journey"} {
		if !strings.Contains(text, want) {
			t.Errorf("SKILL.md never points at %q, so a cold agent cannot reach the feature list", want)
		}
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
