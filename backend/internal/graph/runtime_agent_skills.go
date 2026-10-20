package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LoadedSkill is one skill directory the Agent can see.
// TODO(port): Pi loadSkills diagnostics and formatSkillsForPrompt whitespace are not the SDK's exact text.
type LoadedSkill struct {
	Name                   string `json:"name"`
	Description            string `json:"description"`
	FilePath               string `json:"filePath"`
	DisableModelInvocation bool   `json:"disableModelInvocation"`
}

// SkillDiagnostic is one loader note. The filesystem scan currently records none.
type SkillDiagnostic struct {
	Message string `json:"message"`
}

// AgentSkillSet is the loaded list plus the single available-skills block.
type AgentSkillSet struct {
	Skills      []LoadedSkill     `json:"skills"`
	Diagnostics []SkillDiagnostic `json:"diagnostics"`
	Block       string            `json:"block"`
}

// BoundSkillLink is one capability mirrored into an Agent skills folder.
type BoundSkillLink struct {
	ID     string
	Target string
}

// AgentSkillsScope lists every folder the native loader would read.
type AgentSkillsScope struct {
	Folder      string
	Cwd         string
	ProjectRoot string
	Home        string
	AgentDir    string
}

const piConfigDirName = ".pi"

// AgentSkillsDir is <graph home>/agents/<id>/skills.
func AgentSkillsDir(agentID, home string) string {
	return filepath.Join(home, "agents", agentID, "skills")
}

// AgentSkillOwnedRoots are the capability roots Graph itself may retarget.
func AgentSkillOwnedRoots(capabilityRoot, stateDir string) []string {
	roots := []string{}
	if capabilityRoot != "" {
		roots = append(roots, capabilityRoot)
	}
	roots = append(roots, filepath.Join(stateDir, "capabilities"))
	return roots
}

func agentSkillsInside(root, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), path)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

func agentLinkTarget(path string) (string, error) {
	target, err := os.Readlink(path)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(path), target)
	}
	return filepath.Clean(target), nil
}

func agentOwnedLink(path string, ownedRoots []string) bool {
	target, err := agentLinkTarget(path)
	if err != nil {
		return false
	}
	for _, root := range ownedRoots {
		if agentSkillsInside(root, target) {
			return true
		}
	}
	return false
}

// SyncAgentSkills mirrors bound skills and leaves hand-made entries alone.
func SyncAgentSkills(dir string, ownedRoots []string, links []BoundSkillLink) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	wanted := map[string]string{}
	order := []string{}
	for _, link := range links {
		if _, ok := wanted[link.ID]; !ok {
			order = append(order, link.ID)
		}
		wanted[link.ID] = filepath.Clean(link.Target)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		panic(err)
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink == 0 || !agentOwnedLink(path, ownedRoots) {
			continue
		}
		target, ok := wanted[entry.Name()]
		current, _ := agentLinkTarget(path)
		if ok && current == target {
			delete(wanted, entry.Name())
			continue
		}
		_ = os.Remove(path)
		if ok {
			if err := os.Symlink(target, path); err != nil {
				panic(err)
			}
			delete(wanted, entry.Name())
		}
	}
	for _, id := range order {
		target, ok := wanted[id]
		if !ok {
			continue
		}
		path := filepath.Join(dir, id)
		if _, err := os.Lstat(path); err == nil {
			continue
		}
		if err := os.Symlink(target, path); err != nil {
			panic(err)
		}
	}
}

func defaultPiAgentDir() string {
	// The Pi SDK reads PI_CODING_AGENT_DIR first: the global skills folder follows
	// the agent directory, so the override has to be honoured here too.
	if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")); dir != "" {
		return expandTildePath(dir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	// TODO(port): Pi getAgentDir() is typically ~/.pi/agent.
	return filepath.Join(home, ".pi", "agent")
}

// expandTildePath resolves a leading ~ to the home directory.
func expandTildePath(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return filepath.Clean(path)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Clean(path)
	}
	if path == "~" {
		return home
	}
	return filepath.Join(home, path[2:])
}

// NativeSkillDirs lists the global and project skill folders that exist.
func NativeSkillDirs(cwds []string, home, agentDir string) []string {
	if agentDir == "" {
		agentDir = defaultPiAgentDir()
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	directories := []string{filepath.Join(agentDir, "skills"), filepath.Join(home, ".agents", "skills")}
	for _, cwd := range cwds {
		if cwd == "" {
			continue
		}
		directories = append(directories, filepath.Join(cwd, piConfigDirName, "skills"), filepath.Join(cwd, ".agents", "skills"))
	}
	seen := map[string]bool{}
	out := []string{}
	for _, path := range directories {
		if seen[path] {
			continue
		}
		seen[path] = true
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			out = append(out, path)
		}
	}
	return out
}

func readSkillFile(dir string) (LoadedSkill, bool) {
	path := filepath.Join(dir, "SKILL.md")
	body, err := os.ReadFile(path)
	if err != nil {
		return LoadedSkill{}, false
	}
	name, description, disabled := parseSkillFrontmatter(string(body))
	if name == "" {
		name = filepath.Base(dir)
	}
	return LoadedSkill{Name: name, Description: description, FilePath: dir, DisableModelInvocation: disabled}, true
}

func parseSkillFrontmatter(body string) (name, description string, disabled bool) {
	text := strings.TrimPrefix(body, "\uFEFF")
	if !strings.HasPrefix(text, "---") {
		return "", "", false
	}
	rest := text[3:]
	if strings.HasPrefix(rest, "\r\n") {
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "\n") {
		rest = rest[1:]
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", "", false
	}
	front := rest[:end]
	for _, line := range strings.Split(front, "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "name":
			name = value
		case "description":
			description = value
		case "disable-model-invocation":
			disabled = value == "true"
		}
	}
	return name, description, disabled
}

func skillsIn(path string) []LoadedSkill {
	if skill, ok := readSkillFile(path); ok {
		return []LoadedSkill{skill}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	found := []LoadedSkill{}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if skill, ok := readSkillFile(filepath.Join(path, name)); ok {
			found = append(found, skill)
		}
	}
	return found
}

func formatSkillsBlock(skills []LoadedSkill) string {
	var b strings.Builder
	b.WriteString("<available_skills>\n")
	for _, skill := range skills {
		if skill.DisableModelInvocation {
			continue
		}
		b.WriteString("<skill>\n<name>")
		b.WriteString(skill.Name)
		b.WriteString("</name>\n<description>")
		b.WriteString(skill.Description)
		b.WriteString("</description>\n<location>")
		b.WriteString(filepath.Join(skill.FilePath, "SKILL.md"))
		b.WriteString("</location>\n</skill>\n")
	}
	b.WriteString("</available_skills>")
	return b.String()
}

// AgentSkills loads one folder or a full scope from the filesystem.
func AgentSkills(input any) AgentSkillSet {
	scope := AgentSkillsScope{}
	switch value := input.(type) {
	case string:
		scope.Folder = value
	case AgentSkillsScope:
		scope = value
	default:
		if record := asMap(input); record != nil {
			scope.Folder = mapString(record, "folder", "Folder")
			scope.Cwd = mapString(record, "cwd", "Cwd")
			scope.ProjectRoot = mapString(record, "projectRoot", "ProjectRoot")
			scope.Home = mapString(record, "home", "Home")
			scope.AgentDir = mapString(record, "agentDir", "AgentDir")
		}
	}
	paths := []string{}
	if scope.Folder != "" {
		if info, err := os.Stat(scope.Folder); err == nil && info.IsDir() {
			paths = append(paths, scope.Folder)
		}
	}
	paths = append(paths, NativeSkillDirs([]string{scope.Cwd, scope.ProjectRoot}, scope.Home, scope.AgentDir)...)
	if len(paths) == 0 {
		return AgentSkillSet{Skills: []LoadedSkill{}, Diagnostics: []SkillDiagnostic{}, Block: ""}
	}
	skills := []LoadedSkill{}
	seen := map[string]bool{}
	for _, path := range paths {
		for _, skill := range skillsIn(path) {
			if seen[skill.FilePath] {
				continue
			}
			seen[skill.FilePath] = true
			skills = append(skills, skill)
		}
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	block := ""
	visible := false
	for _, skill := range skills {
		if !skill.DisableModelInvocation {
			visible = true
			break
		}
	}
	if visible {
		block = formatSkillsBlock(skills)
	}
	return AgentSkillSet{Skills: skills, Diagnostics: []SkillDiagnostic{}, Block: block}
}
