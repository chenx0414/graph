package gate

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	SkillsAuthoredBy    = "graph-agent"
	SkillDescriptionMax = 300
	SkillBodyMax        = 24000
	SkillReferencesMax  = 60
	SkillIncidentsMax   = 3
)

var (
	skillTriggerPattern  = regexp.MustCompile(`(?i)use when|use for|use before|use this when|use this skill when|when the user|when you|何时|当你|适用于`)
	skillIncidentName    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}|-incident-|-session-`)
	skillIssuePattern    = regexp.MustCompile(`#\d{3,}`)
	skillDatePattern     = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)
	skillFrontmatter     = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`)
	skillFrontmatterLine = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$`)
)

type SkillWarning struct {
	Rule    string `json:"rule"`
	Message string `json:"message"`
}

type SkillReport struct {
	ID       string         `json:"id"`
	Path     string         `json:"path"`
	Warnings []SkillWarning `json:"warnings"`
}

type Skill struct {
	ID          string
	Path        string
	Name        string
	Description string
	Authored    bool
	Body        string
	References  []string
	Incidents   int
}

func ParseFrontmatter(text string) (map[string]string, string) {
	values := map[string]string{}
	match := skillFrontmatter.FindStringSubmatchIndex(text)
	if match == nil {
		return values, text
	}
	block := text[match[2]:match[3]]
	for _, line := range strings.Split(block, "\n") {
		parsed := skillFrontmatterLine.FindStringSubmatch(strings.TrimSpace(line))
		if parsed == nil {
			continue
		}
		value := strings.TrimSpace(parsed[2])
		value = strings.Trim(value, `"'`)
		values[parsed[1]] = strings.TrimSpace(value)
	}
	return values, text[match[1]:]
}

func FindSkills(directory string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	directories := []string{}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			directories = append(directories, filepath.Join(directory, entry.Name()))
		}
	}
	return directories
}

func InspectSkill(directory string) (Skill, bool) {
	path := filepath.Join(directory, "SKILL.md")
	payload, err := os.ReadFile(path)
	if err != nil {
		return Skill{}, false
	}
	values, body := ParseFrontmatter(string(payload))
	skill := Skill{
		ID:          filepath.Base(directory),
		Path:        path,
		Name:        values["name"],
		Description: values["description"],
		Authored:    values["created-by"] == SkillsAuthoredBy,
		Body:        body,
		Incidents:   len(skillIssuePattern.FindAllString(body, -1)) + len(skillDatePattern.FindAllString(body, -1)),
	}
	if entries, readErr := os.ReadDir(filepath.Join(directory, "references")); readErr == nil {
		for _, entry := range entries {
			skill.References = append(skill.References, entry.Name())
		}
	}
	return skill, true
}

func LintSkill(skill Skill, all bool) []SkillWarning {
	if !skill.Authored && !all {
		return nil
	}
	warnings := []SkillWarning{}
	if skill.Name == "" || skill.Description == "" {
		warnings = append(warnings, SkillWarning{"missing-frontmatter", "SKILL.md needs both `name` and `description` in its front matter"})
	}
	if skill.Name != "" && skill.Name != skill.ID {
		warnings = append(warnings, SkillWarning{"name-mismatch", "front matter name `" + skill.Name + "` does not match the folder `" + skill.ID + "`"})
	}
	if len(skill.Description) > SkillDescriptionMax {
		warnings = append(warnings, SkillWarning{"description-too-long", "description is " + strconv.Itoa(len(skill.Description)) + " characters; keep it under " + strconv.Itoa(SkillDescriptionMax) + " so the whole trigger fits"})
	}
	if len(skill.Body) > SkillBodyMax {
		warnings = append(warnings, SkillWarning{"oversized-body", "body is " + strconv.Itoa(len(skill.Body)) + " characters; `read` loads all of it into context for the rest of the session — move depth into references/"})
	}
	if len(skill.References) > SkillReferencesMax {
		warnings = append(warnings, SkillWarning{"references-sprawl", strconv.Itoa(len(skill.References)) + " reference files; extend a topical file instead of adding one per session"})
	}
	for _, reference := range skill.References {
		if skillIncidentName.MatchString(reference) {
			warnings = append(warnings, SkillWarning{"references-incident-named", "references/" + reference + " is named after an incident or a date; name it by topic"})
		}
	}
	if skill.Authored {
		if skill.Description != "" && !skillTriggerPattern.MatchString(skill.Description) {
			warnings = append(warnings, SkillWarning{"description-not-triggering", "description never says when to use the skill; a model picks skills by that sentence"})
		}
		if skill.Incidents > SkillIncidentsMax {
			warnings = append(warnings, SkillWarning{"incident-log-shape", strconv.Itoa(skill.Incidents) + " issue numbers or dates in the body; a skill states rules, not the story behind them"})
		}
	}
	return warnings
}

func EvidenceProblems(status string) []string {
	problems := []string{}
	for _, line := range strings.Split(strings.TrimSpace(status), "\n") {
		if strings.TrimSpace(line) != "" {
			problems = append(problems, strings.TrimSpace(line))
		}
	}
	return problems
}
