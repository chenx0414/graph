package graph

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var skillNamePattern = regexp.MustCompile(`(?m)^name:\s*(.*)$`)
var skillDescriptionPattern = regexp.MustCompile(`(?m)^description:\s*(.*)$`)

// PromotionResult is a copied skill declaration. Binding stays a user decision.
type PromotionResult struct {
	Promoted struct {
		ID       string
		Version  string
		Path     string
		Replaced bool
	}
	BindHint string
}

func digestSkill(dir string) string {
	hash := sha256.New()
	var walk func(string)
	walk = func(current string) {
		entries, err := os.ReadDir(current)
		if err != nil {
			panic(err)
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			path := filepath.Join(current, entry.Name())
			if entry.IsDir() {
				walk(path)
				continue
			}
			relative, err := filepath.Rel(dir, path)
			if err != nil {
				panic(err)
			}
			hash.Write([]byte(relative))
			hash.Write([]byte{0})
			body, err := os.ReadFile(path)
			if err != nil {
				panic(err)
			}
			hash.Write(body)
			hash.Write([]byte{0})
		}
	}
	walk(dir)
	return fmt.Sprintf("%x", hash.Sum(nil))[:12]
}

// PromoteProjectSkill copies one project skill into the capability library.
func PromoteProjectSkill(projectRoot, skillID, capabilityRoot string) PromotionResult {
	source := filepath.Join(projectRoot, ".agents", "skills", skillID)
	skillFile := filepath.Join(source, "SKILL.md")
	if _, err := os.Stat(skillFile); err != nil {
		Raise("invalid_input", fmt.Sprintf("no project skill '%s' at %s", skillID, skillFile))
	}
	text, err := os.ReadFile(skillFile)
	if err != nil {
		panic(err)
	}
	name := skillFrontField(skillNamePattern, string(text))
	description := skillFrontField(skillDescriptionPattern, string(text))
	if name == "" || description == "" {
		Raise("invalid_input", fmt.Sprintf("project skill '%s' needs both name and description in its front matter before it can be promoted", skillID))
	}
	version := digestSkill(source)
	target := filepath.Join(capabilityRoot, "skills", skillID)
	manifestPath := filepath.Join(target, "capability.json")
	replaced := false
	if existingBody, err := os.ReadFile(manifestPath); err == nil {
		var existing struct {
			Version string `json:"version"`
		}
		_ = json.Unmarshal(existingBody, &existing)
		replaced = existing.Version != version
		if existing.Version == version {
			return promotionResult(skillID, version, target, false)
		}
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		panic(err)
	}
	if err := copySkillTree(source, target); err != nil {
		panic(err)
	}
	promotedFrom := filepath.ToSlash(strings.TrimPrefix(source, projectRoot+string(filepath.Separator)))
	manifest := map[string]any{
		"id":           skillID,
		"kind":         "skill",
		"version":      version,
		"name":         name,
		"description":  description,
		"source":       "graph:project",
		"createdBy":    "graph-agent",
		"promotedFrom": promotedFrom,
		"promotedAt":   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(manifestPath, append(body, '\n'), 0o644); err != nil {
		panic(err)
	}
	return promotionResult(skillID, version, target, replaced)
}

func promotionResult(id, version, path string, replaced bool) PromotionResult {
	result := PromotionResult{BindHint: fmt.Sprintf("把它绑进配方：按 docs/agent/agent-recipes.md 在组合的 resources 里加 {resourceId:\"%s\",role:\"skill\",required:true,version:\"%s\"}；本接口不替你绑定。", id, version)}
	result.Promoted.ID = id
	result.Promoted.Version = version
	result.Promoted.Path = path
	result.Promoted.Replaced = replaced
	return result
}

func skillFrontField(pattern *regexp.Regexp, text string) string {
	match := pattern.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func copySkillTree(source, target string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(target, relative)
		if info.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.Create(dest)
		if err != nil {
			return err
		}
		defer output.Close()
		_, err = io.Copy(output, input)
		return err
	})
}

// PromoteSkillFromProjects promotes the skill from whichever known project holds it.
func PromoteSkillFromProjects(projectRoots []string, skillID, capabilityRoot string) PromotionResult {
	holder := ""
	for _, root := range projectRoots {
		path := filepath.Join(root, ".agents", "skills", skillID, "SKILL.md")
		if _, err := os.Stat(path); err == nil {
			holder = root
			break
		}
	}
	if holder == "" {
		Raise("invalid_input", fmt.Sprintf("no known project holds a skill named '%s'", skillID))
	}
	return PromoteProjectSkill(holder, skillID, capabilityRoot)
}
