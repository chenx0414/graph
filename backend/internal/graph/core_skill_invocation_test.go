// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var pigSkillBlockRe = regexp.MustCompile(`^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n</skill>(?:\n\n([\s\S]+))?$`)

func pigSkillBlock(text string) []string {
	start := strings.Index(text, "<skill ")
	if start < 0 {
		return nil
	}
	return pigSkillBlockRe.FindStringSubmatch(strings.TrimRight(text[start:], "\n"))
}

func skillFixture(t *testing.T, name, body string) BoundSkill {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := "---\nname: " + name + "\n---\n" + body
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return BoundSkill{Name: name, Path: dir}
}

func TestSlashSkillInjectsTheBoundSkillBodyForTheTurn(t *testing.T) {
	skill := skillFixture(t, "architect", "# Architect\n\nDraw the boxes before the code.")
	other := skillFixture(t, "review", "# Review\n\nRead the diff twice.")
	result := InjectRequestedSkills("plan the change /skill:architect please", []BoundSkill{skill, other}, nil)
	if len(result.Injected) != 1 || result.Injected[0] != "architect" {
		t.Fatalf("injected %v instead of just the requested skill", result.Injected)
	}
	if len(result.Rejected) != 0 {
		t.Fatalf("a bound skill was rejected: %v", result.Rejected)
	}
	if !strings.Contains(result.Text, "Draw the boxes before the code.") {
		t.Fatalf("the skill body never reached the turn text")
	}
	if strings.Contains(result.Text, "Read the diff twice.") {
		t.Fatalf("a skill nobody asked for was injected")
	}
	if strings.Contains(result.Text, "---\nname: architect") {
		t.Fatalf("the front matter was injected with the body")
	}
	if !strings.Contains(result.Text, `<skill name="architect" location="`+skillBodyPath(skill.Path)+`">`) {
		t.Fatalf("the injected block does not name the skill and its file")
	}
	if !strings.HasPrefix(result.Text, "plan the change /skill:architect please") {
		t.Fatalf("the user text was rewritten instead of extended: %q", result.Text)
	}
}

func TestSlashSkillRejectsAnUnboundNameWithItsReason(t *testing.T) {
	skill := skillFixture(t, "architect", "body")
	result := InjectRequestedSkills("/skill:pstack-skills-architect", []BoundSkill{skill}, nil)
	if len(result.Injected) != 0 {
		t.Fatalf("an unbound name was injected: %v", result.Injected)
	}
	if len(result.Rejected) != 1 || result.Rejected[0].Name != "pstack-skills-architect" {
		t.Fatalf("rejection did not name the request: %v", result.Rejected)
	}
	if !strings.Contains(result.Rejected[0].Reason, "not bound") {
		t.Fatalf("rejection carries no reason: %q", result.Rejected[0].Reason)
	}
	if !strings.Contains(result.Text, "Not injected:") {
		t.Fatalf("the turn text does not tell the model what was skipped")
	}
}

func TestSlashSkillNeedsTheTokenAtAWordBoundary(t *testing.T) {
	skill := skillFixture(t, "architect", "body")
	attached := InjectRequestedSkills("请用，/skill:architect", []BoundSkill{skill}, nil)
	if len(attached.Injected) != 0 {
		t.Fatalf("a token glued to punctuation was still parsed as a request")
	}
	spaced := InjectRequestedSkills("请用 /skill:architect", []BoundSkill{skill}, nil)
	if len(spaced.Injected) != 1 {
		t.Fatalf("a token after whitespace was not parsed")
	}
	if names := RequestedSkillNames("/skill:a /skill:a /skill:b"); len(names) != 2 {
		t.Fatalf("repeated names were not deduplicated: %v", names)
	}
}

func TestSlashSkillWithoutAnyRequestLeavesTheTurnTextAlone(t *testing.T) {
	skill := skillFixture(t, "architect", "body")
	result := InjectRequestedSkills("just a normal message", []BoundSkill{skill}, nil)
	if result.Text != "just a normal message" {
		t.Fatalf("a turn without a skill request was rewritten: %q", result.Text)
	}
	if len(result.Injected) != 0 || len(result.Rejected) != 0 {
		t.Fatalf("a turn without a request reported injection work")
	}
}

func TestSlashSkillClipsABodyThatWouldFloodTheTurn(t *testing.T) {
	body := strings.Repeat("x", SKILL_BODY_LIMIT+500)
	skill := skillFixture(t, "huge", body)
	result := InjectRequestedSkills("/skill:huge", []BoundSkill{skill}, nil)
	if len(result.Injected) != 1 {
		t.Fatalf("the oversized skill was not injected: %v", result.Rejected)
	}
	if !strings.Contains(result.Text, "truncated") {
		t.Fatalf("the clipped body does not say it was truncated")
	}
	if len([]rune(result.Text)) > SKILL_BODY_LIMIT+4000 {
		t.Fatalf("the turn text grew to %d characters", len([]rune(result.Text)))
	}
}

func TestSlashSkillNamesItsFileAndTheDirectoryRelativeReferencesResolveAgainst(t *testing.T) {
	skill := skillFixture(t, "scripts", "# Scripts\n\nRun `scripts/collect.sh` before reporting.")
	result := InjectRequestedSkills("/skill:scripts", []BoundSkill{skill}, nil)
	location := skillBodyPath(skill.Path)
	if !strings.Contains(result.Text, `location="`+location+`"`) {
		t.Fatalf("the block must name the file it was read from (%s):\n%s", location, result.Text)
	}
	if !strings.Contains(result.Text, "References are relative to "+skill.Path+".\n") {
		t.Fatalf("the block must say what directory relative paths resolve against (%s):\n%s", skill.Path, result.Text)
	}
}

func TestTheInjectedSkillBlockUsesThePiGShape(t *testing.T) {
	skill := skillFixture(t, "architect", "# Architect\n\nRun scripts/build.sh before you draw anything.")
	result := InjectRequestedSkills("/skill:architect", []BoundSkill{skill}, nil)
	block := pigSkillBlock(result.Text)
	if block == nil {
		t.Fatalf("the injected block does not parse as a PiG skill block: %q", result.Text)
	}
	if block[1] != "architect" {
		t.Fatalf("block names %q", block[1])
	}
	if block[2] != filepath.Join(skill.Path, "SKILL.md") {
		t.Fatalf("location is %q instead of the skill file", block[2])
	}
	if !strings.HasPrefix(block[3], "References are relative to "+skill.Path+".\n") {
		t.Fatalf("base directory hint missing or wrong: %q", block[3])
	}
	if !strings.Contains(block[3], "Run scripts/build.sh before you draw anything.") {
		t.Fatalf("body missing from the block: %q", block[3])
	}
}

func TestASkillPathPointingAtTheFileStillNamesItsDirectory(t *testing.T) {
	skill := skillFixture(t, "architect", "body")
	file := BoundSkill{Name: "architect", Path: filepath.Join(skill.Path, "SKILL.md")}
	result := InjectRequestedSkills("/skill:architect", []BoundSkill{file}, nil)
	if !strings.Contains(result.Text, "References are relative to "+skill.Path+".\n") {
		t.Fatalf("base directory was the file itself: %q", result.Text)
	}
}
