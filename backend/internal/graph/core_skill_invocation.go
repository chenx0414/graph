package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// SKILL_TOKEN selects one skill bound to the Agent for this turn.
var SKILL_TOKEN = regexp.MustCompile(`(?:^|\s)/skill:([A-Za-z0-9._-]+)`)

const SKILL_BODY_LIMIT = 40000
const SKILL_TOTAL_LIMIT = 120000

type BoundSkill struct {
	Name    string  `json:"name"`
	Path    string  `json:"path"`
	Version *string `json:"version,omitempty"`
}

type SkillRejection struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type SkillInjection struct {
	Text     string           `json:"text"`
	Injected []string         `json:"injected"`
	Rejected []SkillRejection `json:"rejected"`
}

// BoundSkills are the skills a resolved capability bundle actually bound.
func BoundSkills(facts []struct {
	Id      string
	Version string
	Kind    string
	Path    string
}, catalog interface {
	Capability(id string, version string) *CapabilityRecord
}) []BoundSkill {
	out := []BoundSkill{}
	for _, fact := range facts {
		if fact.Kind != "skill" {
			continue
		}
		name := fact.Id
		if record := catalog.Capability(fact.Id, fact.Version); record != nil && record.Name != "" {
			name = record.Name
		}
		version := fact.Version
		out = append(out, BoundSkill{Name: name, Path: fact.Path, Version: &version})
	}
	return out
}

func RequestedSkillNames(text string) []string {
	names := []string{}
	for _, match := range SKILL_TOKEN.FindAllStringSubmatch(text, -1) {
		if len(match) < 2 || match[1] == "" {
			continue
		}
		seen := false
		for _, name := range names {
			if name == match[1] {
				seen = true
				break
			}
		}
		if !seen {
			names = append(names, match[1])
		}
	}
	return names
}

func skillBodyPath(path string) string {
	if strings.HasSuffix(path, ".md") {
		return path
	}
	return filepath.Join(path, "SKILL.md")
}

var skillFrontMatter = regexp.MustCompile(`(?s)^---\r?\n.*?\r?\n---\r?\n`)

func stripFrontMatter(raw string) string {
	return skillFrontMatter.ReplaceAllString(raw, "")
}

func readSkillBody(skill BoundSkill, budget int) *string {
	raw, err := os.ReadFile(skillBodyPath(skill.Path))
	if err != nil {
		return nil
	}
	body := stripFrontMatter(string(raw))
	room := SKILL_BODY_LIMIT
	if budget < room {
		room = budget
	}
	if utf16Len(body) <= room {
		return &body
	}
	clipped := utf16Slice(body, room) + fmt.Sprintf("\n\n[truncated: the body is %s characters and only the first %s were injected]", enUS(utf16Len(body)), enUS(room))
	return &clipped
}

func trimEnd(value string) string {
	return strings.TrimRightFunc(value, unicode.IsSpace)
}

// InjectRequestedSkills appends the bodies of the skills this turn asked for.
func InjectRequestedSkills(text string, skills []BoundSkill, names []string) SkillInjection {
	requested := names
	if names == nil {
		requested = RequestedSkillNames(text)
	}
	if len(requested) == 0 {
		return SkillInjection{Text: text, Injected: []string{}, Rejected: []SkillRejection{}}
	}
	byName := map[string]BoundSkill{}
	for _, skill := range skills {
		byName[skill.Name] = skill
	}
	injected := []string{}
	rejected := []SkillRejection{}
	blocks := []string{}
	budget := SKILL_TOTAL_LIMIT
	for _, name := range requested {
		skill, ok := byName[name]
		if !ok {
			rejected = append(rejected, SkillRejection{Name: name, Reason: "not bound to this Agent"})
			continue
		}
		body := readSkillBody(skill, budget)
		if body == nil {
			rejected = append(rejected, SkillRejection{Name: name, Reason: "body unreadable at " + skill.Path})
			continue
		}
		budget -= utf16Len(*body)
		injected = append(injected, name)
		version := ""
		if skill.Version != nil && *skill.Version != "" {
			version = fmt.Sprintf(` version="%s"`, *skill.Version)
		}
		blocks = append(blocks, strings.Join([]string{
			fmt.Sprintf(`<skill name="%s"%s>`, name, version),
			trimEnd(*body),
			"</skill>",
		}, "\n"))
		if budget <= 0 {
			break
		}
	}
	if len(blocks) == 0 && len(rejected) == 0 {
		return SkillInjection{Text: text, Injected: injected, Rejected: rejected}
	}
	lines := []string{
		"",
		"The user explicitly requested these skills for this turn with `/skill:<name>`.",
		"Their instructions are below and apply to this turn; do not claim a skill was followed without doing what it says.",
	}
	if len(rejected) > 0 {
		parts := make([]string, 0, len(rejected))
		for _, item := range rejected {
			parts = append(parts, fmt.Sprintf("`%s` (%s)", item.Name, item.Reason))
		}
		lines = append(lines, "Not injected: "+strings.Join(parts, ", ")+".")
	}
	if budget <= 0 {
		lines = append(lines, fmt.Sprintf("Only the first %s characters of requested skill bodies fit in one turn.", enUS(SKILL_TOTAL_LIMIT)))
	}
	return SkillInjection{
		Text:     trimEnd(text) + "\n" + strings.Join(lines, "\n") + "\n\n" + strings.Join(blocks, "\n\n") + "\n",
		Injected: injected,
		Rejected: rejected,
	}
}
