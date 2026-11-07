package graph

import (
	"path/filepath"
	"sort"
	"strings"

	"os"
)

func pigSessionInstructions(request AgentSessionRequest) string {
	parts := []string{}
	if request.SystemPrompt != "" {
		parts = append(parts, request.SystemPrompt)
	}
	if context := pigProjectContextPrompt(request.Workspace, request.StateDir); context != "" {
		parts = append(parts, context)
	}
	if skills := pigSkillsPrompt(pigSessionSkills(request)); skills != "" {
		parts = append(parts, skills)
	}
	if request.Workspace != "" {
		parts = append(parts, "<cwd>"+request.Workspace+"</cwd>")
	}
	return strings.Join(parts, "\n\n")
}

func pigProjectContextPrompt(workspace string, agentDir string) string {
	type contextFile struct {
		path    string
		content string
	}
	files := []contextFile{}
	seen := map[string]bool{}
	add := func(dir string) {
		if dir == "" {
			return
		}
		path, content, ok := agentContextProjectInstructions(dir)
		if !ok || seen[path] {
			return
		}
		seen[path] = true
		files = append(files, contextFile{path: path, content: content})
	}
	add(agentDir)
	ancestors := []contextFile{}
	for dir := workspace; dir != ""; {
		path, content, ok := agentContextProjectInstructions(dir)
		if ok && !seen[path] {
			seen[path] = true
			ancestors = append([]contextFile{{path: path, content: content}}, ancestors...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	files = append(files, ancestors...)
	if len(files) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<project_context>\n")
	for index, file := range files {
		if index > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("## ")
		b.WriteString(file.path)
		b.WriteString("\n")
		b.WriteString(file.content)
	}
	b.WriteString("\n</project_context>")
	return b.String()
}

func pigSessionSkills(request AgentSessionRequest) []LoadedSkill {
	paths := []string{}
	if request.SkillFolder != "" {
		paths = append(paths, request.SkillFolder)
	}
	paths = append(paths, request.SkillPaths...)
	skills := []LoadedSkill{}
	seenFiles := map[string]bool{}
	seenNames := map[string]bool{}
	for _, path := range paths {
		for _, skill := range pigSkillsIn(path) {
			if strings.TrimSpace(skill.Description) == "" {
				continue
			}
			file := pigSkillFilePath(skill)
			key := pigCanonicalPath(file)
			if seenFiles[key] || seenNames[skill.Name] {
				continue
			}
			seenFiles[key] = true
			seenNames[skill.Name] = true
			skills = append(skills, skill)
		}
	}
	return skills
}

func pigSkillsIn(path string) []LoadedSkill {
	if skill, ok := readSkillFile(path); ok {
		return []LoadedSkill{skill}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
			continue
		}
		if entry.Type()&os.ModeSymlink == 0 {
			continue
		}
		info, err := os.Stat(filepath.Join(path, entry.Name()))
		if err != nil || !info.IsDir() {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	found := []LoadedSkill{}
	for _, name := range names {
		if skill, ok := readSkillFile(filepath.Join(path, name)); ok {
			found = append(found, skill)
		}
	}
	return found
}

func pigSkillsPrompt(skills []LoadedSkill) string {
	visible := []LoadedSkill{}
	for _, skill := range skills {
		if skill.DisableModelInvocation {
			continue
		}
		visible = append(visible, skill)
	}
	if len(visible) == 0 {
		return ""
	}
	lines := []string{
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	}
	for _, skill := range visible {
		lines = append(lines,
			"  <skill>",
			"    <name>"+pigSkillXML(skill.Name)+"</name>",
			"    <description>"+pigSkillXML(skill.Description)+"</description>",
			"    <location>"+pigSkillXML(pigSkillFilePath(skill))+"</location>",
			"  </skill>",
		)
	}
	lines = append(lines, "</available_skills>")
	return "\n\n" + strings.Join(lines, "\n")
}

func pigSkillFilePath(skill LoadedSkill) string {
	return filepath.Join(skill.FilePath, "SKILL.md")
}

func pigCanonicalPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return resolved
}

func pigSkillXML(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(value)
}
