package skilldoc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

const skillBody = `---
name: verify-graph
description: Drive the Graph desktop app when you must prove a user-facing feature works.
---

# verify-graph

## Launch

` + "```sh\nverification/verify-graph launch --json\n```" + `

## Doctor

` + "```sh\nverification/verify-graph doctor\n```" + `

## Drive

` + "```sh\nverification/verify-graph ui click --label 设置\n```" + `

## Evidence

` + "```sh\nverification/verify-graph evidence verify --run <run>\n```" + `

## Cleanup

` + "```sh\nverification/verify-graph cleanup --run <run>\n```" + `
`

const featureBody = `# F-14 设置页

## Sub-features

- 配置读写

## How to get to it (user POV)

点侧栏「设置」。

## Driving it with verify-graph

` + "```sh\nverification/verify-graph ui click --label 设置\n```" + `

## Gotchas

- 只在隔离实例里改配置。
`

const indexBody = `{"schema":1,"features":[{"id":"F-14","file":"features/F-14-settings.md"}]}`

func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write(t, root, "SKILL.md", skillBody)
	write(t, root, "features/README.md", "# map\n")
	write(t, root, "features/F-14-settings.md", featureBody)
	write(t, root, "features/index.json", indexBody)
	return root
}

func codes(problems []Problem) []string {
	values := []string{}
	for _, problem := range problems {
		values = append(values, problem.Code)
	}
	return values
}

func hasCode(problems []Problem, code string) bool {
	for _, problem := range problems {
		if problem.Code == code {
			return true
		}
	}
	return false
}

func TestACompleteSkillPasses(t *testing.T) {
	report, err := Check(fixture(t))
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !report.OK() {
		t.Fatalf("a complete skill must pass, got %v", report.Problems)
	}
	if len(report.Features) != 1 || report.Features[0] != "F-14-settings.md" {
		t.Fatalf("features = %v", report.Features)
	}
	for _, want := range []string{"launch", "doctor", "ui", "evidence", "cleanup"} {
		if !contains(report.Commands, want) {
			t.Fatalf("commands %v miss %q", report.Commands, want)
		}
	}
}

func TestMissingSkillFileIsReported(t *testing.T) {
	root := fixture(t)
	if err := os.Remove(filepath.Join(root, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "skill-missing") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestMissingFrontmatterFailsTheSkill(t *testing.T) {
	root := fixture(t)
	write(t, root, "SKILL.md", strings.Replace(skillBody, "---\nname: verify-graph", "# no frontmatter\nname: verify-graph", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "skill-frontmatter") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestMissingSkillSectionIsReported(t *testing.T) {
	root := fixture(t)
	write(t, root, "SKILL.md", strings.Replace(skillBody, "## Cleanup", "## Tidying up", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	found := false
	for _, problem := range report.Problems {
		if problem.Code == "skill-section-missing" && strings.Contains(problem.Detail, "Cleanup") {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v", report.Problems)
	}
}

func TestMissingFeatureSectionIsReported(t *testing.T) {
	root := fixture(t)
	write(t, root, "features/F-14-settings.md", strings.Replace(featureBody, "## Gotchas", "## Notes", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "feature-section-missing") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestFeatureWithoutARunCommandIsReported(t *testing.T) {
	root := fixture(t)
	body := strings.Replace(featureBody, "```sh\nverification/verify-graph ui click --label 设置\n```", "看截图就行。", 1)
	write(t, root, "features/F-14-settings.md", body)
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "feature-no-command") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestFeatureWithoutGotchasIsReported(t *testing.T) {
	root := fixture(t)
	write(t, root, "features/F-14-settings.md", strings.Replace(featureBody, "- 只在隔离实例里改配置。", "", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "feature-no-gotchas") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestUnknownCommandInDocsIsReported(t *testing.T) {
	root := fixture(t)
	write(t, root, "features/F-14-settings.md", strings.Replace(featureBody,
		"verification/verify-graph ui click --label 设置", "verification/verify-graph frobnicate --label 设置", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	found := false
	for _, problem := range report.Problems {
		if problem.Code == "unknown-command" && strings.Contains(problem.Detail, "frobnicate") {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v", report.Problems)
	}
}

func TestIndexMustListEveryFeatureAndOnlyRealFiles(t *testing.T) {
	root := fixture(t)
	write(t, root, "features/F-15-tray.md", strings.Replace(featureBody, "F-14 设置页", "F-15 托盘", 1))
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "index-incomplete") {
		t.Fatalf("a file missing from the index must be reported: %v", codes(report.Problems))
	}

	root = fixture(t)
	write(t, root, "features/index.json", `{"schema":1,"features":[{"id":"F-14","file":"features/F-14-settings.md"},{"id":"F-99","file":"features/F-99-ghost.md"}]}`)
	report, err = Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "index-dangling") {
		t.Fatalf("a dangling index entry must be reported: %v", codes(report.Problems))
	}
}

func TestMissingFeatureMapIsReported(t *testing.T) {
	root := t.TempDir()
	write(t, root, "SKILL.md", skillBody)
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !hasCode(report.Problems, "feature-map-missing") {
		t.Fatalf("problems = %v", codes(report.Problems))
	}
}

func TestSectionBodyStopsAtTheNextHeading(t *testing.T) {
	text := "## Gotchas\n\n- one\n\n## Next\n\n- two\n"
	if got := strings.TrimSpace(section(text, "Gotchas")); got != "- one" {
		t.Fatalf("section = %q", got)
	}
}

func TestTheRepositorySkillSatisfiesTheContract(t *testing.T) {
	root := repositorySkillDir(t)
	report, err := Check(root)
	if err != nil {
		t.Fatalf("check %s: %v", root, err)
	}
	for _, problem := range report.Problems {
		t.Errorf("%s", problem.String())
	}
	if len(report.Features) == 0 {
		t.Fatalf("%s maps no feature", root)
	}
}

func repositorySkillDir(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(directory, "skills", "verify-graph")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			t.Skip("no skills/verify-graph above this package; the artifact is assembled elsewhere")
		}
		directory = parent
	}
}

func TestRCommandsComeFromTheBinaryWhenItRuns(t *testing.T) {
	root := repositorySkillDir(t)
	commands, err := LiveCommands(root)
	if err != nil {
		t.Skipf("the CLI cannot report its surface yet: %v", err)
	}
	if len(commands) == 0 {
		t.Fatalf("%s help --json listed no command", root)
	}
	report, err := CheckAgainst(root, commands)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	for _, problem := range report.Problems {
		t.Errorf("%s", problem.String())
	}
}
