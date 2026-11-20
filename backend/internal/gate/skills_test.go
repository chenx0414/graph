package gate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSkill(t *testing.T, root, name, frontmatter, body string) string {
	t.Helper()
	directory := filepath.Join(root, name)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", directory, err)
	}
	payload := "---\n" + frontmatter + "\n---\n" + body
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte(payload), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	return directory
}

func rulesOf(warnings []SkillWarning) []string {
	rules := make([]string, 0, len(warnings))
	for _, warning := range warnings {
		rules = append(rules, warning.Rule)
	}
	return rules
}

func TestLintSkillReportsAuthoredRuleBreaches(t *testing.T) {
	root := t.TempDir()
	directory := writeSkill(t, root, "some-skill", "name: other-name\ndescription: does things\ncreated-by: graph-agent", strings.Repeat("x", 24001))
	for _, reference := range []string{"2026-01-02-bug.md", "topic.md"} {
		if err := os.MkdirAll(filepath.Join(directory, "references"), 0o755); err != nil {
			t.Fatalf("mkdir references: %v", err)
		}
		if err := os.WriteFile(filepath.Join(directory, "references", reference), []byte("body"), 0o644); err != nil {
			t.Fatalf("write reference: %v", err)
		}
	}
	skill, ok := InspectSkill(directory)
	if !ok {
		t.Fatalf("skill not found in %s", directory)
	}
	got := strings.Join(rulesOf(LintSkill(skill, false)), ",")
	want := "name-mismatch,oversized-body,references-incident-named,description-not-triggering"
	if got != want {
		t.Fatalf("rules = %q, want %q", got, want)
	}
}

func TestLintSkillPassesOnATriggeringSkill(t *testing.T) {
	root := t.TempDir()
	directory := writeSkill(t, root, "good-skill", "name: good-skill\ndescription: Use when the user asks for the good thing\ncreated-by: graph-agent", "Do the good thing.\n")
	skill, ok := InspectSkill(directory)
	if !ok {
		t.Fatalf("skill not found in %s", directory)
	}
	if warnings := LintSkill(skill, false); len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none", rulesOf(warnings))
	}
}

func TestLintSkillIgnoresForeignSkillsUnlessAllIsSet(t *testing.T) {
	root := t.TempDir()
	directory := writeSkill(t, root, "upstream-skill", "name: upstream-skill\ndescription: no trigger sentence here", "body\n")
	skill, ok := InspectSkill(directory)
	if !ok {
		t.Fatalf("skill not found in %s", directory)
	}
	if warnings := LintSkill(skill, false); len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none for a foreign skill", rulesOf(warnings))
	}
	if warnings := LintSkill(skill, true); len(warnings) != 0 {
		t.Fatalf("warnings = %v: trigger and incident rules stay with authored skills", rulesOf(warnings))
	}
	nameless := writeSkill(t, root, "nameless-skill", "description: Use when something", "body\n")
	skill, ok = InspectSkill(nameless)
	if !ok {
		t.Fatalf("skill not found in %s", nameless)
	}
	if warnings := LintSkill(skill, false); len(warnings) != 0 {
		t.Fatalf("warnings = %v for a foreign skill", rulesOf(warnings))
	}
	if got := strings.Join(rulesOf(LintSkill(skill, true)), ","); got != "missing-frontmatter" {
		t.Fatalf("rules under --all = %q", got)
	}
}

func TestLintSkillCountsIncidentReferences(t *testing.T) {
	root := t.TempDir()
	directory := writeSkill(t, root, "log-skill", "name: log-skill\ndescription: Use when reading the incident story\ncreated-by: graph-agent", "see #123 and #456 on 2026-01-02 and 2026-01-03\n")
	skill, ok := InspectSkill(directory)
	if !ok {
		t.Fatalf("skill not found in %s", directory)
	}
	if skill.Incidents != 4 {
		t.Fatalf("incidents = %d, want 4", skill.Incidents)
	}
	if got := strings.Join(rulesOf(LintSkill(skill, false)), ","); got != "incident-log-shape" {
		t.Fatalf("rules = %q", got)
	}
}

func TestParseFrontmatterReadsQuotedValuesAndKeepsBody(t *testing.T) {
	values, body := ParseFrontmatter("---\nname: \"quoted\"\ndescription: 'single'\n---\nthe body\n")
	if values["name"] != "quoted" || values["description"] != "single" {
		t.Fatalf("values = %v", values)
	}
	if body != "\nthe body\n" {
		t.Fatalf("body = %q", body)
	}
}

func TestEvidenceProblemsListsChangedFiles(t *testing.T) {
	problems := EvidenceProblems(" M acceptance-evidence/a.md\n?? acceptance-evidence/b.md\n")
	if len(problems) != 2 || problems[0] != "M acceptance-evidence/a.md" || problems[1] != "?? acceptance-evidence/b.md" {
		t.Fatalf("problems = %v", problems)
	}
	if got := EvidenceProblems("   \n"); len(got) != 0 {
		t.Fatalf("problems = %v, want none", got)
	}
}

func TestRepoSkillsAreGraphAuthored(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	allowlisted := map[string]bool{"agent-desktop": true}
	directories := append(FindSkills(filepath.Join(root, ".agents", "skills")), FindSkills(filepath.Join(root, ".pi", "skills"))...)
	for _, directory := range directories {
		skill, ok := InspectSkill(directory)
		if !ok || skill.Authored || allowlisted[skill.ID] {
			continue
		}
		t.Errorf("%s: shipped skill is not authored by %s; a vendored bundle belongs outside the repository", skill.Path, SkillsAuthoredBy)
	}
}

func TestRepoAuthoredSkillsLintClean(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	authored := 0
	for _, directory := range append(FindSkills(filepath.Join(root, ".agents", "skills")), FindSkills(filepath.Join(root, ".pi", "skills"))...) {
		skill, ok := InspectSkill(directory)
		if !ok || !skill.Authored {
			continue
		}
		authored++
		for _, warning := range LintSkill(skill, false) {
			t.Errorf("%s: %s: %s", skill.ID, warning.Rule, warning.Message)
		}
	}
	if authored == 0 {
		t.Fatalf("no authored skill found under %s", root)
	}
}
