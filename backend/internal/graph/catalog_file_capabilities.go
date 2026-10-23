package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CapabilityManifest is one capability.json document.
type CapabilityManifest struct {
	Id             string                  `json:"id"`
	Kind           string                  `json:"kind"`
	Version        string                  `json:"version"`
	Name           string                  `json:"name"`
	Description    string                  `json:"description,omitempty"`
	Role           string                  `json:"role,omitempty"`
	Command        string                  `json:"command,omitempty"`
	Args           []string                `json:"args,omitempty"`
	Url            string                  `json:"url,omitempty"`
	Headers        map[string]string       `json:"headers,omitempty"`
	HeadersEnv     map[string]string       `json:"headersEnv,omitempty"`
	NetworkDomains []string                `json:"networkDomains,omitempty"`
	Provisioning   *CapabilityProvisioning `json:"provisioning,omitempty"`
	NetworkAccess  string                  `json:"networkAccess,omitempty"`
	Entry          string                  `json:"entry,omitempty"`
	Source         string                  `json:"source,omitempty"`
	Tools          []CapabilityTool        `json:"tools,omitempty"`
	Base           bool                    `json:"base,omitempty"`
	Runtime        *CapabilityRuntimeDecl  `json:"runtime,omitempty"`
	Tags           []string                `json:"tags,omitempty"`
	// Extra keeps the keys the capability document carried beyond the known
	// ones. The TypeScript manifest spreads them into the object itself.
	Extra map[string]any `json:"-"`
}

// MarshalJSON writes the manifest the way the TypeScript manifest object
// reads: the known fields, plus the raw keys the document carried.
func (manifest CapabilityManifest) MarshalJSON() ([]byte, error) {
	type alias CapabilityManifest
	raw, err := json.Marshal(alias(manifest))
	if err != nil {
		return nil, err
	}
	object := map[string]any{}
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	for key, value := range manifest.Extra {
		if _, taken := object[key]; !taken {
			object[key] = value
		}
	}
	return json.Marshal(object)
}

type CapabilityProvisioning struct {
	Manager string   `json:"manager,omitempty"`
	Domains []string `json:"domains,omitempty"`
}

type CapabilityTool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type CapabilityRuntimeDecl struct {
	Commands          []string          `json:"commands,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	ReadPaths         []string          `json:"readPaths,omitempty"`
	WritePaths        []string          `json:"writePaths,omitempty"`
	NetworkDomains    []string          `json:"networkDomains,omitempty"`
	NetworkAccess     string            `json:"networkAccess,omitempty"`
	AllowLocalBinding *bool             `json:"allowLocalBinding,omitempty"`
	UnixSockets       []string          `json:"unixSockets,omitempty"`
}

const fileCapabilitiesMaxScanDepth = 4

var (
	fileCapabilitiesKinds = map[string]bool{"skill": true, "mcp": true, "extension": true, "pi-extension": true, "prompt": true}
	fileCapabilitiesID    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	fileCapabilitiesSkip  = map[string]bool{"node_modules": true, ".git": true, ".worker-home": true, ".worker-tmp": true}
	fileCapabilitiesEnv   = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
)

func fileCapabilitiesText(value any, label string) string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		Raise("invalid_capability", label+" must be a nonempty string")
	}
	return strings.TrimSpace(text)
}

// ParseCapabilityManifest validates one capability document.
func ParseCapabilityManifest(value any, path string) CapabilityManifest {
	raw, ok := value.(map[string]any)
	if !ok {
		Raise("invalid_capability", path+" must contain a capability object")
	}
	id := fileCapabilitiesText(raw["id"], path+".id")
	if !fileCapabilitiesID.MatchString(id) {
		Raise("invalid_capability", path+".id must use lowercase letters, numbers and hyphens")
	}
	kind := fileCapabilitiesText(raw["kind"], path+".kind")
	if !fileCapabilitiesKinds[kind] {
		Raise("invalid_capability", path+".kind is unsupported")
	}
	version := fileCapabilitiesText(raw["version"], path+".version")
	name := fileCapabilitiesText(raw["name"], path+".name")
	description := ""
	if _, present := raw["description"]; present {
		description = fileCapabilitiesText(raw["description"], path+".description")
	}
	role := ""
	if _, present := raw["role"]; present {
		role = fileCapabilitiesText(raw["role"], path+".role")
	}
	if role != "" && role != "agent" && role != "tool" {
		Raise("invalid_capability", path+".role must be agent or tool")
	}
	base := false
	if rawBase, present := raw["base"]; present {
		flag, ok := rawBase.(bool)
		if !ok {
			Raise("invalid_capability", path+".base must be a boolean")
		}
		base = flag
	}
	if kind == "prompt" && role == "" {
		Raise("invalid_capability", path+".role is required for prompt capabilities")
	}
	command := ""
	if _, present := raw["command"]; present {
		command = fileCapabilitiesText(raw["command"], path+".command")
	}
	args := fileCapabilitiesStringList(raw["args"], path+".args")
	url := ""
	if _, present := raw["url"]; present {
		url = fileCapabilitiesText(raw["url"], path+".url")
	}
	var provisioning *CapabilityProvisioning
	if rawProvisioning, present := raw["provisioning"]; present {
		value, ok := rawProvisioning.(map[string]any)
		if !ok {
			Raise("invalid_capability", path+".provisioning must be an object")
		}
		manager := ""
		if _, ok := value["manager"]; ok {
			manager = fileCapabilitiesText(value["manager"], path+".provisioning.manager")
		}
		if manager != "" && manager != "uv" && manager != "npm" {
			Raise("invalid_capability", path+".provisioning.manager must be uv or npm")
		}
		expected := ""
		if command == "uvx" {
			expected = "uv"
		} else if command == "npx" {
			expected = "npm"
		}
		if expected == "" {
			Raise("invalid_capability", path+".provisioning is only valid for local uvx or npx MCP commands")
		}
		if manager != "" && manager != expected {
			Raise("invalid_capability", path+".provisioning.manager does not match command "+command)
		}
		if manager == "" {
			manager = expected
		}
		provisioning = &CapabilityProvisioning{Manager: manager, Domains: fileCapabilitiesDomains(value["domains"], path+".provisioning.domains")}
	}
	headers := fileCapabilitiesStringMap(raw["headers"], path+".headers")
	headersEnv := fileCapabilitiesStringMap(raw["headersEnv"], path+".headersEnv")
	domains := fileCapabilitiesDomains(raw["networkDomains"], path+".networkDomains")
	networkAccess := ""
	if _, present := raw["networkAccess"]; present {
		networkAccess = fileCapabilitiesText(raw["networkAccess"], path+".networkAccess")
	}
	if networkAccess != "" && networkAccess != "unrestricted" {
		Raise("invalid_capability", path+".networkAccess must be \"unrestricted\"")
	}
	if domains != nil && kind != "mcp" {
		Raise("invalid_capability", path+".networkDomains is only valid for MCP capabilities")
	}
	if networkAccess != "" && kind != "mcp" {
		Raise("invalid_capability", path+".networkAccess is only valid for MCP capabilities")
	}
	if domains != nil && networkAccess != "" {
		Raise("invalid_capability", path+" cannot combine networkDomains with unrestricted network access")
	}
	entry := ""
	if _, present := raw["entry"]; present {
		entry = fileCapabilitiesText(raw["entry"], path+".entry")
	}
	source := ""
	if text, ok := raw["source"].(string); ok {
		source = text
	}
	tags := fileCapabilitiesStringList(raw["tags"], path+".tags")
	var tools []CapabilityTool
	if rawTools, present := raw["tools"]; present {
		list, ok := rawTools.([]any)
		if !ok {
			Raise("invalid_capability", path+".tools must be an array")
		}
		tools = make([]CapabilityTool, len(list))
		for index, item := range list {
			tool, ok := item.(map[string]any)
			if !ok {
				Raise("invalid_capability", path+".tools["+itoa(index)+"] must be an object")
			}
			tools[index].Name = fileCapabilitiesText(tool["name"], path+".tools["+itoa(index)+"].name")
			if _, ok := tool["description"]; ok {
				tools[index].Description = fileCapabilitiesText(tool["description"], path+".tools["+itoa(index)+"].description")
			}
		}
	}
	var runtime *CapabilityRuntimeDecl
	if rawRuntime, present := raw["runtime"]; present {
		value, ok := rawRuntime.(map[string]any)
		if !ok {
			Raise("invalid_capability", path+".runtime must be an object")
		}
		if kind != "pi-extension" {
			Raise("invalid_capability", path+".runtime is only valid for Pi extensions")
		}
		commands := fileCapabilitiesStringList(value["commands"], path+".runtime.commands")
		for _, command := range commands {
			if strings.ContainsAny(command, "\x00\r\n;|&`$<>") {
				Raise("invalid_capability", path+".runtime.commands contains an invalid command")
			}
		}
		runtimeEnv := fileCapabilitiesStringMap(value["env"], path+".runtime.env")
		for name := range runtimeEnv {
			if !secretRefPattern.MatchString(name) {
				Raise("invalid_capability", path+".runtime.env contains an invalid variable name")
			}
		}
		runtimeDomains := fileCapabilitiesDomains(value["networkDomains"], path+".runtime.networkDomains")
		runtimeAccess := ""
		if _, ok := value["networkAccess"]; ok {
			runtimeAccess = fileCapabilitiesText(value["networkAccess"], path+".runtime.networkAccess")
		}
		if runtimeAccess != "" && runtimeAccess != "unrestricted" {
			Raise("invalid_capability", path+".runtime.networkAccess must be \"unrestricted\"")
		}
		if runtimeDomains != nil && runtimeAccess != "" {
			Raise("invalid_capability", path+" cannot combine runtime networkDomains with unrestricted network access")
		}
		var allow *bool
		if rawAllow, ok := value["allowLocalBinding"]; ok {
			flag, ok := rawAllow.(bool)
			if !ok {
				Raise("invalid_capability", path+".runtime.allowLocalBinding must be boolean")
			}
			allow = &flag
		}
		runtime = &CapabilityRuntimeDecl{
			Commands: commands, Env: runtimeEnv, ReadPaths: fileCapabilitiesStringList(value["readPaths"], path+".runtime.readPaths"),
			WritePaths: fileCapabilitiesStringList(value["writePaths"], path+".runtime.writePaths"), NetworkDomains: runtimeDomains,
			NetworkAccess: runtimeAccess, AllowLocalBinding: allow, UnixSockets: fileCapabilitiesStringList(value["unixSockets"], path+".runtime.unixSockets"),
		}
	}
	return CapabilityManifest{
		Id: id, Kind: kind, Version: version, Name: name, Description: description, Role: role, Command: command, Args: args,
		Url: url, Headers: headers, HeadersEnv: headersEnv, NetworkDomains: domains, Provisioning: provisioning,
		NetworkAccess: networkAccess, Entry: entry, Source: source, Tools: tools, Base: base, Runtime: runtime, Tags: tags,
		Extra: raw,
	}
}

func fileCapabilitiesStringMap(value any, label string) map[string]string {
	if value == nil {
		return nil
	}
	record, ok := value.(map[string]any)
	if !ok {
		Raise("invalid_capability", label+" must be a string map")
	}
	out := map[string]string{}
	for key, item := range record {
		text, ok := item.(string)
		if !ok {
			Raise("invalid_capability", label+" must be a string map")
		}
		out[key] = strings.TrimSpace(text)
	}
	return out
}

func fileCapabilitiesStringList(value any, label string) []string {
	if value == nil {
		return nil
	}
	list, ok := value.([]any)
	if !ok {
		Raise("invalid_capability", label+" must be an array of nonempty strings")
	}
	out := make([]string, len(list))
	for i, item := range list {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			Raise("invalid_capability", label+" must be an array of nonempty strings")
		}
		out[i] = strings.TrimSpace(text)
	}
	return out
}

func fileCapabilitiesDomains(value any, label string) []string {
	domains := fileCapabilitiesStringList(value, label)
	if domains == nil {
		return nil
	}
	for _, domain := range domains {
		expanded := fileCapabilitiesEnv.ReplaceAllString(domain, "placeholder.example")
		if strings.Contains(expanded, "$") {
			Raise("invalid_capability", label+" contains an invalid environment reference")
		}
		if err := portRecover(func() { NormalizeDomainPattern(expanded) }); err != nil {
			Raise("invalid_capability", label+" must contain host patterns or environment references")
		}
	}
	return domains
}

// ReadCapabilityManifest reads capability.json from a directory.
func ReadCapabilityManifest(directory string) CapabilityManifest {
	path := filepath.Join(directory, "capability.json")
	body, err := os.ReadFile(path)
	if err != nil {
		Raise("invalid_capability", "Cannot read "+path+": "+err.Error())
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		Raise("invalid_capability", "Cannot read "+path+": "+err.Error())
	}
	return ParseCapabilityManifest(parsed, path)
}

func fileCapabilitiesValidateFiles(directory string, manifest CapabilityManifest) {
	if manifest.Kind == "skill" {
		skill := filepath.Join(directory, "SKILL.md")
		body, err := os.ReadFile(skill)
		if err != nil {
			Raise("invalid_capability", directory+" is a skill without SKILL.md")
		}
		if strings.TrimSpace(string(body)) == "" {
			Raise("invalid_capability", skill+" is empty")
		}
	}
	if manifest.Kind == "prompt" {
		name := "agent.md"
		if manifest.Role == "tool" {
			name = "tool.md"
		}
		prompt := filepath.Join(directory, name)
		body, err := os.ReadFile(prompt)
		if err != nil {
			Raise("invalid_capability", directory+" is a "+manifest.Role+" prompt without "+name)
		}
		if strings.TrimSpace(string(body)) == "" {
			Raise("invalid_capability", prompt+" is empty")
		}
	}
	if manifest.Kind == "mcp" && manifest.Command == "" && manifest.Url == "" {
		Raise("invalid_capability", directory+" is an MCP capability without command or url")
	}
	if manifest.Kind == "extension" || manifest.Kind == "pi-extension" {
		sourced := manifest.Kind == "pi-extension" && strings.TrimSpace(manifest.Source) != ""
		if !sourced {
			entry := manifest.Entry
			if entry == "" {
				entry = "./index.mjs"
			}
			path := entry
			if !filepath.IsAbs(entry) {
				path = filepath.Clean(filepath.Join(directory, entry))
			}
			if path != directory && !strings.HasPrefix(path, directory+string(os.PathSeparator)) {
				Raise("invalid_capability", directory+" extension entry must stay inside its capability directory")
			}
			if _, err := os.Stat(path); err != nil {
				Raise("invalid_capability", directory+" extension entry "+entry+" does not exist")
			}
		}
	}
}

const skillFrontmatterError = "SKILL.md 缺少 frontmatter（name/description）：原生加载器会跳过它"

type skillFront struct {
	Name                   string
	Description            string
	DisableModelInvocation bool
	HasFrontmatter         bool
	Present                bool
}

func fileCapabilitiesFrontmatter(directory string) skillFront {
	file := filepath.Join(directory, "SKILL.md")
	body, err := os.ReadFile(file)
	if err != nil {
		return skillFront{}
	}
	front := skillFront{Present: true}
	block := regexp.MustCompile(`(?s)^---\s*\r?\n(.*?)\r?\n---`).FindStringSubmatch(string(body))
	if block == nil {
		return front
	}
	front.HasFrontmatter = true
	values := map[string]string{}
	for _, line := range regexp.MustCompile(`\r?\n`).Split(block[1], -1) {
		parsed := regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$`).FindStringSubmatch(line)
		if parsed == nil {
			continue
		}
		values[parsed[1]] = strings.Trim(strings.TrimSpace(parsed[2]), `"'`)
	}
	front.Name = values["name"]
	front.Description = values["description"]
	front.DisableModelInvocation = strings.EqualFold(values["disable-model-invocation"], "true")
	return front
}

func fileCapabilitiesSkillNote(directory string) string {
	front := fileCapabilitiesFrontmatter(directory)
	if !front.Present {
		return ""
	}
	if !front.HasFrontmatter {
		return skillFrontmatterError
	}
	if front.DisableModelInvocation {
		return "声明了 disable-model-invocation：不会进入系统提示（原生语义为仅显式调用）"
	}
	return ""
}

// ScanNativeSkills lists hand-made skill folders. Symlinks are the bound mirror and are skipped.
func ScanNativeSkills(skillsDir, owner string, origin CapabilityOrigin) []CapabilityRecord {
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	sort.Slice(entries, func(i, j int) bool { return lessByByteOrder(entries[i].Name(), entries[j].Name()) })
	records := []CapabilityRecord{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !entry.IsDir() || info.Mode()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(skillsDir, entry.Name())
		if _, err := os.Stat(filepath.Join(directory, "SKILL.md")); err != nil {
			continue
		}
		front := fileCapabilitiesFrontmatter(directory)
		note := fileCapabilitiesSkillNote(directory)
		usable := front.HasFrontmatter
		record := CapabilityRecord{
			Id: entry.Name(), Kind: "skill", Source: directory, Version: "local",
			Snapshot: map[string]any{"path": directory}, Status: "available", Owner: owner, Origin: origin,
		}
		if !usable {
			record.Status = "invalid"
			record.Error = skillFrontmatterError
		}
		if front.Name != "" {
			record.Name = front.Name
		}
		if front.Description != "" {
			record.Description = front.Description
		}
		if note != "" {
			record.Note = note
		}
		records = append(records, record)
	}
	return records
}

// ScanAgentSkills lists skills placed in any Agent folder.
func ScanAgentSkills(agentsRoot string) []CapabilityRecord {
	agents, err := os.ReadDir(agentsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	names := []os.DirEntry{}
	for _, agent := range agents {
		if agent.IsDir() && !strings.HasPrefix(agent.Name(), ".") {
			names = append(names, agent)
		}
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	records := []CapabilityRecord{}
	for _, agent := range names {
		records = append(records, ScanNativeSkills(filepath.Join(agentsRoot, agent.Name(), "skills"), agent.Name(), "agent")...)
	}
	return records
}

func fileCapabilitiesWalk(root, directory string, depth int, records *[]CapabilityRecord) {
	if depth > fileCapabilitiesMaxScanDepth {
		return
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		if depth == 0 && os.IsNotExist(err) {
			return
		}
		panic(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() != "capability.json" {
			continue
		}
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			message := panicMessage(rec)
			id := strings.TrimPrefix(directory, root)
			id = strings.TrimPrefix(id, string(os.PathSeparator))
			id = strings.ReplaceAll(id, string(os.PathSeparator), "-")
			if id == "" {
				id = directory
			}
			*records = append(*records, CapabilityRecord{
				Id: id, Kind: "skill", Source: directory, Version: "invalid",
				Snapshot: map[string]any{"path": directory, "error": message}, Status: "invalid", Error: message,
			})
		}()
		manifest := ReadCapabilityManifest(directory)
		fileCapabilitiesValidateFiles(directory, manifest)
		note := ""
		if manifest.Kind == "skill" {
			note = fileCapabilitiesSkillNote(directory)
		}
		record := CapabilityRecord{
			Id: manifest.Id, Kind: manifest.Kind, Source: directory, Version: manifest.Version,
			Snapshot: map[string]any{"path": directory, "manifest": manifest}, Status: "available", Name: manifest.Name,
		}
		if manifest.Description != "" {
			record.Description = manifest.Description
		}
		if manifest.Role != "" {
			record.Role = manifest.Role
		}
		if note != "" {
			record.Note = note
		}
		if manifest.Kind == "pi-extension" && strings.TrimSpace(manifest.Source) != "" {
			source := strings.TrimSpace(manifest.Source)
			record.PackageSource = &source
		}
		if manifest.Base {
			record.Base = true
		}
		*records = append(*records, record)
		return
	}
	sorted := append([]os.DirEntry{}, entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name() < sorted[j].Name() })
	for _, entry := range sorted {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || fileCapabilitiesSkip[entry.Name()] {
			continue
		}
		fileCapabilitiesWalk(root, filepath.Join(directory, entry.Name()), depth+1, records)
	}
}

// ScanCapabilities walks a capability root up to four directories deep.
func ScanCapabilities(root string) []CapabilityRecord {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	records := []CapabilityRecord{}
	fileCapabilitiesWalk(resolved, resolved, 0, &records)
	seen := map[string]CapabilityRecord{}
	for i := range records {
		if records[i].Status == "invalid" {
			continue
		}
		key := records[i].Id + "@" + records[i].Version
		if previous, ok := seen[key]; ok {
			records[i].Status = "invalid"
			records[i].Error = "Duplicate capability " + key + "; also found at " + previous.Source
			records[i].Snapshot = map[string]any{"path": records[i].Source, "error": records[i].Error}
			continue
		}
		seen[key] = records[i]
	}
	return records
}
