package graph

import (
	"path/filepath"
	"sort"
	"strings"

	"os"
)

// pigSessionInstructions is the system prompt of one PiG session.
//
// The order is the SDK's: Graph's own prompt first, then what only the
// environment knows.
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

// pigProjectContextPrompt is the project context of one session.
//
// The context files are the ones the SDK looked for: the agent directory's own
// file first, then the working directory's and its ancestors, the outermost
// ancestor first.
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
	// The SDK collects the ancestors from the working directory upwards and
	// puts the outermost one first.
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

// pigSessionSkills are the skills one session may load.
//
// The list is the one the sidecar handed to the SDK: the Agent's own folder
// first, then the folders the session may read. A name belongs to the first
// folder that offers it, and a file reached through two folders is one skill.
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
				// A skill without a description cannot be matched to a task,
				// so the SDK never offered it.
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

// pigSkillsIn are the skills one folder offers.
//
// A folder offers itself when it holds a SKILL.md, and otherwise every
// subfolder that does. A symbolic link to a folder is followed: the bound
// capabilities are linked into the Agent's own folder, and the model is told
// where to read them.
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

// pigSkillsPrompt is the skills block of one session.
//
// It is the block the SDK wrote, in the SDK's shape: the model is told that
// the skills carry specialized instructions and how to load one. A skill that
// disables model invocation stays out of the prompt - it is only ever
// invoked by name.
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
	// The SDK's block opens with a blank line of its own.
	return "\n\n" + strings.Join(lines, "\n")
}

// pigSkillFilePath is the file one skill lives in.
func pigSkillFilePath(skill LoadedSkill) string {
	return filepath.Join(skill.FilePath, "SKILL.md")
}

// pigCanonicalPath is the path without its symbolic links.
//
// Two paths that lead to the same file are one skill, however they are named.
func pigCanonicalPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return resolved
}

// pigSkillXML escapes the text of a skill for the XML block.
func pigSkillXML(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(value)
}
