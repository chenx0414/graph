package skilldoc

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var Commands = []string{
	"doctor", "build", "launch", "status", "api", "ui",
	"scenario", "verify", "evidence", "cleanup", "help", "version", "cover",
}

var RequiredSkillSections = []string{"Launch", "Doctor", "Drive", "Evidence", "Cleanup"}

var RequiredFeatureSections = []string{
	"Sub-features",
	"How to get to it (user POV)",
	"Driving it with verify-graph",
	"Gotchas",
}

type Problem struct {
	Code   string `json:"code"`
	File   string `json:"file"`
	Detail string `json:"detail"`
}

func (p Problem) String() string {
	if p.File == "" {
		return p.Code + ": " + p.Detail
	}
	return p.File + ": " + p.Code + ": " + p.Detail
}

type Report struct {
	Root     string    `json:"root"`
	Skill    string    `json:"skill,omitempty"`
	Features []string  `json:"features"`
	Commands []string  `json:"commandsMentioned"`
	Problems []Problem `json:"problems"`
}

func (r Report) OK() bool { return len(r.Problems) == 0 }

type commandMention struct {
	Doc     string
	Line    string
	Command string
}

func Check(skillDir string) (Report, error) {
	return CheckAgainst(skillDir, Commands)
}

func CheckAgainst(skillDir string, commands []string) (Report, error) {
	allowed := append([]string(nil), commands...)
	report := Report{Root: skillDir, Features: []string{}, Commands: []string{}}
	entries, err := os.ReadDir(skillDir)
	if err != nil {
		return report, fmt.Errorf("skilldoc: cannot read %s: %w", skillDir, err)
	}
	skillPath := filepath.Join(skillDir, "SKILL.md")
	if _, err := os.Stat(skillPath); err != nil {
		report.Problems = append(report.Problems, Problem{Code: "skill-missing", File: "SKILL.md",
			Detail: "the skill has no SKILL.md; a cold agent needs frontmatter and the launch/doctor/drive/evidence/cleanup sections"})
	} else {
		problems, mentioned := checkSkill(skillPath, allowed)
		report.Problems = append(report.Problems, problems...)
		for _, mention := range mentioned {
			if !contains(report.Commands, mention.Command) {
				report.Commands = append(report.Commands, mention.Command)
			}
		}
		report.Skill = "SKILL.md"
	}

	featureDir := ""
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() == "features" {
			featureDir = filepath.Join(skillDir, "features")
			break
		}
	}
	if featureDir == "" {
		report.Problems = append(report.Problems, Problem{Code: "feature-map-missing", File: "features",
			Detail: "there is no features/ directory; the map is how an agent finds out how to verify one feature"})
		return report, nil
	}

	files, err := featureFiles(featureDir)
	if err != nil {
		return report, err
	}
	report.Features = files
	for _, name := range files {
		path := filepath.Join(featureDir, name)
		featureProblems, mentioned := checkFeature(path, "features/"+name, allowed)
		report.Problems = append(report.Problems, featureProblems...)
		for _, mention := range mentioned {
			if !contains(allowed, mention.Command) {
				report.Problems = append(report.Problems, Problem{Code: "unknown-command", File: mention.Doc,
					Detail: fmt.Sprintf("line %q drives %q, which is not one of: %s", mention.Line, mention.Command, strings.Join(allowed, ", "))})
			}
			if !contains(report.Commands, mention.Command) {
				report.Commands = append(report.Commands, mention.Command)
			}
		}
	}

	report.Problems = append(report.Problems, checkIndex(featureDir, files)...)
	sort.Slice(report.Problems, func(i, j int) bool {
		if report.Problems[i].File != report.Problems[j].File {
			return report.Problems[i].File < report.Problems[j].File
		}
		return report.Problems[i].Detail < report.Problems[j].Detail
	})
	sort.Strings(report.Commands)
	return report, nil
}

func featureFiles(featureDir string) ([]string, error) {
	entries, err := os.ReadDir(featureDir)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		if entry.Name() == "README.md" {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

func checkSkill(path string, allowed []string) ([]Problem, []commandMention) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return []Problem{{Code: "unreadable", File: "SKILL.md", Detail: err.Error()}}, nil
	}
	text := string(payload)
	problems := []Problem{}
	if !strings.HasPrefix(strings.TrimSpace(text), "---") {
		problems = append(problems, Problem{Code: "skill-frontmatter", File: "SKILL.md",
			Detail: "the file does not start with YAML frontmatter; without name/description the skill never registers"})
	} else {
		header := frontmatter(text)
		for _, key := range []string{"name:", "description:"} {
			if !strings.Contains(header, key) {
				problems = append(problems, Problem{Code: "skill-frontmatter", File: "SKILL.md",
					Detail: "the frontmatter is missing " + strings.TrimSuffix(key, ":")})
			}
		}
	}
	headings := headingsOf(text)
	for _, required := range RequiredSkillSections {
		if !matchesHeading(headings, required) {
			problems = append(problems, Problem{Code: "skill-section-missing", File: "SKILL.md",
				Detail: fmt.Sprintf("no section for %q; a cold agent reads this first", required)})
		}
	}
	mentions := mentionsOf(text, "SKILL.md")
	for _, mention := range mentions {
		if !contains(allowed, mention.Command) {
			problems = append(problems, Problem{Code: "unknown-command", File: "SKILL.md",
				Detail: fmt.Sprintf("line %q drives %q, which the CLI does not offer; use one of %s", mention.Line, mention.Command, strings.Join(allowed, ", "))})
		}
	}
	return problems, mentions
}

func checkFeature(path, name string, allowed []string) ([]Problem, []commandMention) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return []Problem{{Code: "unreadable", File: name, Detail: err.Error()}}, nil
	}
	text := string(payload)
	problems := []Problem{}
	headings := headingsOf(text)
	for _, required := range RequiredFeatureSections {
		if !matchesHeading(headings, required) {
			problems = append(problems, Problem{Code: "feature-section-missing", File: name,
				Detail: fmt.Sprintf("no %q section; the map is read cold", required)})
		}
	}
	mentions := mentionsOf(text, name)
	driving := section(text, "Driving it with verify-graph")
	if strings.TrimSpace(driving) != "" && len(mentionsOf(driving, name)) == 0 {
		problems = append(problems, Problem{Code: "feature-no-command", File: name,
			Detail: "the Driving section names no verify-graph command, so a reader cannot run this feature"})
	}
	if strings.TrimSpace(section(text, "Gotchas")) == "" {
		problems = append(problems, Problem{Code: "feature-no-gotchas", File: name,
			Detail: "the Gotchas section is empty; a feature without gotchas hides the reason it fails"})
	}
	return problems, mentions
}

type indexFile struct {
	Features []indexFeature `json:"features"`
}

type indexFeature struct {
	ID   string `json:"id"`
	File string `json:"file"`
}

func checkIndex(featureDir string, files []string) []Problem {
	path := filepath.Join(featureDir, "index.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		return []Problem{{Code: "index-missing", File: "features/index.json",
			Detail: "no machine-readable index; tooling cannot map a feature id to its file"}}
	}
	var index indexFile
	if err := json.Unmarshal(payload, &index); err != nil {
		return []Problem{{Code: "index-invalid", File: "features/index.json", Detail: err.Error()}}
	}
	problems := []Problem{}
	listed := map[string]bool{}
	for _, feature := range index.Features {
		base := filepath.Base(strings.TrimSpace(feature.File))
		if base == "" || base == "." {
			problems = append(problems, Problem{Code: "index-invalid", File: "features/index.json",
				Detail: fmt.Sprintf("feature %q has no file", feature.ID)})
			continue
		}
		listed[base] = true
		if !contains(files, base) {
			problems = append(problems, Problem{Code: "index-dangling", File: "features/index.json",
				Detail: fmt.Sprintf("feature %q points at %s, which does not exist", feature.ID, base)})
		}
	}
	for _, name := range files {
		if !listed[name] {
			problems = append(problems, Problem{Code: "index-incomplete", File: "features/" + name,
				Detail: "the file is not listed in features/index.json, so nothing can look it up by id"})
		}
	}
	return problems
}

func frontmatter(text string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(text), "---")
	if index := strings.Index(trimmed, "---"); index >= 0 {
		return trimmed[:index]
	}
	return trimmed
}

var headingPattern = regexp.MustCompile(`(?m)^(#{1,6})\s+(.*?)\s*$`)

func headingsOf(text string) []string {
	headings := []string{}
	for _, match := range headingPattern.FindAllStringSubmatch(text, -1) {
		headings = append(headings, match[2])
	}
	return headings
}

func matchesHeading(headings []string, want string) bool {
	loweredWant := strings.ToLower(strings.TrimSpace(want))
	for _, heading := range headings {
		if strings.ToLower(strings.TrimSpace(heading)) == loweredWant {
			return true
		}
	}
	return false
}

func section(text, want string) string {
	lines := strings.Split(text, "\n")
	collecting := false
	fenced := false
	collected := []string{}
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			fenced = !fenced
			if collecting {
				collected = append(collected, line)
			}
			continue
		}
		if fenced {
			if collecting {
				collected = append(collected, line)
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			title := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if collecting {
				break
			}
			if strings.EqualFold(title, want) {
				collecting = true
			}
			continue
		}
		if collecting {
			collected = append(collected, line)
		}
	}
	return strings.Join(collected, "\n")
}

var verifyCommandPattern = regexp.MustCompile(`verify-graph\s+([a-z][a-z-]*)`)

func mentionsOf(text, doc string) []commandMention {
	mentions := []commandMention{}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "#!") {
			continue
		}
		for _, match := range verifyCommandPattern.FindAllStringSubmatch(line, -1) {
			if match[1] == "" {
				continue
			}
			mentions = append(mentions, commandMention{Doc: doc, Line: trimmed, Command: match[1]})
		}
	}
	return mentions
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
