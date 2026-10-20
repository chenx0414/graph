package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

func capabilityBundleDigest(value any) string {
	sum := sha256.Sum256([]byte(CanonicalJSON(value)))
	return hex.EncodeToString(sum[:])
}

// CapabilityBundleOptions selects one definition's capability closure.
type CapabilityBundleOptions struct {
	FrozenFacts       []ResolvedCapabilityFact
	Catalog           *Catalog
	DefinitionVersion string
	Bootstrap         *CapabilityBootstrap
	McpDomains        []string
	Secrets           func() map[string]string
	SkillFolder       string
	SkillCwd          string
	SkillProjectRoot  string
	SkillOwnedRoots   []string
}

// CapabilityBootstrap is the immutable Graph prompt pair.
type CapabilityBootstrap struct {
	Agent string
	Tool  string
}

// CapabilityOperationOptions opens one executable operation of a bundle.
type CapabilityOperationOptions struct {
	Workspace            string
	ScratchDir           string
	Gate                 SendGate
	Action               string
	Role                 string
	ReadOnly             bool
	Grants               []string
	AdditionalReadRoots  []string
	Access               *ResolvedAccessPolicy
	DisabledTools        []string
	NativeTools          []string
	OnPermissionRequired func(CapabilityPermissionRequest)
	HostTools            func(readRoots []string) []ToolDefinition
}

// CapabilityOperation is the tool surface and digests one turn binds to.
type CapabilityOperation struct {
	Descriptor               any
	BundleDigest             string
	ToolPolicyDigest         string
	RuntimePolicyDigest      string
	LegacyPromptDigest       string
	Tools                    []ToolDefinition
	NativeTools              []string
	AllowedToolNames         []string
	Prompts                  CapabilityOperationPrompts
	Report                   []RuntimeCapabilityLoadFact
	SkillPaths               []string
	SkillFolder              string
	ReadRoots                []string
	WriteRoots               []string
	Env                      map[string]string
	NetworkDomains           []string
	AllowUnrestrictedNetwork bool
	AllowLocalBinding        bool
	UnixSockets              []string
	PiExtensionPaths         []string
	PiExtensionTools         []string
	McpAdapterServers        []McpAdapterServerRef
	Close                    func()
}

// CapabilityOperationPrompts is the system and tool text for one operation.
type CapabilityOperationPrompts struct {
	System string
	Tool   *string
}

// CapabilityBundleVersion is one resolved definition closure.
type CapabilityBundleVersion struct {
	DefinitionVersion   string
	Digest              string
	ToolPolicyDigest    string
	RuntimePolicyDigest string
	Facts               []ResolvedCapabilityFact
	SkillFolder         string
	input               CapabilityBundleOptions
}

func capabilitySkillFolder(options CapabilityBundleOptions) string {
	if options.SkillFolder != "" {
		return options.SkillFolder
	}
	agentID := ""
	if options.DefinitionVersion != "" {
		agentID = strings.Split(options.DefinitionVersion, "@")[0]
	}
	root := ""
	if options.Catalog != nil {
		root = options.Catalog.CapabilityRootPath()
	}
	if agentID == "" || root == "" {
		return ""
	}
	return AgentSkillsDir(agentID, filepath.Dir(root))
}

func capabilityCloneFacts(facts []ResolvedCapabilityFact) []ResolvedCapabilityFact {
	raw, err := json.Marshal(facts)
	if err != nil {
		panic(err)
	}
	var copy []ResolvedCapabilityFact
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	if copy == nil {
		return []ResolvedCapabilityFact{}
	}
	return copy
}

// OpenCapabilityBundle resolves facts and mirrors bound skills.
func OpenCapabilityBundle(options CapabilityBundleOptions) *CapabilityBundleVersion {
	facts := options.FrozenFacts
	if facts == nil {
		facts = ResolveCapabilityFacts(options.Catalog, options.DefinitionVersion)
	}
	folder := capabilitySkillFolder(options)
	if folder != "" && options.FrozenFacts == nil {
		links := []BoundSkillLink{}
		for _, fact := range facts {
			if fact.Kind == "skill" && fact.Path != "" {
				links = append(links, BoundSkillLink{ID: fact.Id, Target: filepath.Dir(fact.Path)})
			}
		}
		owned := options.SkillOwnedRoots
		if owned == nil {
			owned = []string{}
		}
		SyncAgentSkills(folder, owned, links)
	}
	version := &CapabilityBundleVersion{input: options, DefinitionVersion: options.DefinitionVersion, SkillFolder: folder, Facts: capabilityCloneFacts(facts)}
	type declaredTool struct {
		CapabilityId      string `json:"capabilityId"`
		CapabilityVersion string `json:"capabilityVersion"`
		Name              string `json:"name"`
		Description       string `json:"description"`
	}
	declared := []declaredTool{}
	for _, fact := range version.Facts {
		for _, tool := range capabilityDeclaredTools(fact) {
			declared = append(declared, declaredTool{CapabilityId: fact.Id, CapabilityVersion: fact.Version, Name: tool.Name, Description: tool.Description})
		}
	}
	sort.Slice(declared, func(i, j int) bool {
		return declared[i].CapabilityId+"@"+declared[i].CapabilityVersion+":"+declared[i].Name < declared[j].CapabilityId+"@"+declared[j].CapabilityVersion+":"+declared[j].Name
	})
	version.ToolPolicyDigest = capabilityBundleDigest(map[string]any{"piExtensionTools": declared})
	runtimeFacts := []any{}
	for _, fact := range version.Facts {
		var role any
		if fact.Role != "" {
			role = fact.Role
		}
		var network any
		if fact.NetworkAccess != "" {
			network = fact.NetworkAccess
		}
		domains := fact.NetworkDomains
		if domains == nil {
			domains = []string{}
		}
		tools := []capabilityDeclaredTool{}
		tools = append(tools, capabilityDeclaredTools(fact)...)
		var provisioning any
		if fact.Provisioning != nil {
			provisioning = fact.Provisioning
		}
		runtimeFacts = append(runtimeFacts, map[string]any{
			"id": fact.Id, "version": fact.Version, "kind": fact.Kind, "role": role, "digest": fact.Digest,
			"declaredTools": tools, "networkDomains": domains, "networkAccess": network, "provisioning": provisioning,
		})
	}
	version.RuntimePolicyDigest = capabilityBundleDigest(map[string]any{"capabilities": runtimeFacts})
	var definition any
	if version.DefinitionVersion != "" {
		definition = version.DefinitionVersion
	}
	version.Digest = capabilityBundleDigest(map[string]any{
		"definitionVersion": definition, "toolPolicyDigest": version.ToolPolicyDigest, "runtimePolicyDigest": version.RuntimePolicyDigest,
	})
	return version
}

func capabilityUnique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func capabilitySortedCopy(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

// OpenOperation loads capabilities and freezes the digests a turn may use.
func (version *CapabilityBundleVersion) OpenOperation(options CapabilityOperationOptions) CapabilityOperation {
	var loaded LoadedCapabilities
	var operation CapabilityOperation
	opened := false
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if opened && loaded.Close != nil {
			func() { defer func() { _ = recover() }(); loaded.Close() }()
		}
		panic(recovered)
	}()
	input := CapabilityLoadInput{
		Catalog: version.input.Catalog, Workspace: options.Workspace, ScratchDir: options.ScratchDir, Gate: options.Gate,
		ReadOnly: options.ReadOnly, Access: options.Access,
	}
	if version.input.DefinitionVersion != "" {
		input.DefinitionVersion = version.input.DefinitionVersion
		input.HasDefinitionVersion = true
	}
	if version.input.Bootstrap != nil {
		input.Bootstrap = version.input.Bootstrap
	}
	if len(version.input.McpDomains) > 0 {
		input.McpDomains = version.input.McpDomains
	}
	if version.input.Secrets != nil {
		input.Secrets = version.input.Secrets()
	}
	if options.Grants != nil {
		input.Grants = options.Grants
	}
	if options.OnPermissionRequired != nil {
		input.OnPermissionRequired = options.OnPermissionRequired
	}
	input.FrozenFacts = version.input.FrozenFacts
	loaded = LoadCapabilities(input)
	opened = true
	facts := []McpAdapterFact{}
	for _, fact := range version.Facts {
		role := fact.Role
		if role == "" {
			role = "tool"
		}
		facts = append(facts, McpAdapterFact{Id: fact.Id, Version: fact.Version, Kind: fact.Kind, Path: fact.Path, Role: role})
	}
	secrets := map[string]string{}
	if version.input.Secrets != nil {
		secrets = version.input.Secrets()
	}
	adapterServers := McpAdapterServers(facts, secrets)
	readRoots := capabilityUnique(append(append([]string{}, loaded.ReadRoots...), options.AdditionalReadRoots...))
	if version.SkillFolder != "" && version.input.FrozenFacts == nil {
		links := []BoundSkillLink{}
		for _, fact := range loaded.Report {
			if capabilityFactKind(fact) == "skill" && capabilityFactPath(fact) != "" {
				links = append(links, BoundSkillLink{ID: fact.Id, Target: filepath.Dir(capabilityFactPath(fact))})
			}
		}
		owned := version.input.SkillOwnedRoots
		if owned == nil {
			owned = []string{}
		}
		SyncAgentSkills(version.SkillFolder, owned, links)
	}
	disabled := map[string]bool{}
	for _, name := range options.DisabledTools {
		name = strings.TrimSpace(name)
		if name != "" {
			disabled[name] = true
		}
	}
	hostTools := []ToolDefinition{}
	if options.HostTools != nil {
		hostTools = options.HostTools(readRoots)
	}
	selected := SelectAgentToolSurface(append(hostTools, loaded.Tools...), options.NativeTools, options.DisabledTools, loaded.PiExtensionTools)
	folderSkills := AgentSkills(AgentSkillsScope{Folder: version.SkillFolder, Cwd: version.input.SkillCwd, ProjectRoot: version.input.SkillProjectRoot}).Skills
	excluded := map[string]bool{}
	for _, skill := range folderSkills {
		if skill.DisableModelInvocation {
			excluded[skill.Name] = true
		}
	}
	recorded := map[string]bool{}
	for _, fact := range loaded.Report {
		if capabilityFactKind(fact) == "skill" {
			recorded[fact.Id] = true
		}
	}
	report := append([]RuntimeCapabilityLoadFact{}, loaded.Report...)
	for _, skill := range folderSkills {
		if recorded[skill.Name] {
			continue
		}
		report = append(report, capabilityPastedSkill(skill))
	}
	filtered := make([]RuntimeCapabilityLoadFact, 0, len(report))
	for _, fact := range report {
		kept := capabilityFilterTools(fact, disabled)
		name := capabilityFactName(kept)
		if name == "" {
			name = kept.Id
		}
		if capabilityFactKind(kept) == "skill" && excluded[name] {
			kept = capabilityWithReason(kept, "声明了 disable-model-invocation：不会进入系统提示（原生语义为仅显式调用）")
		}
		filtered = append(filtered, kept)
	}
	definitionVersion := version.DefinitionVersion
	if definitionVersion == "" {
		definitionVersion = "unknown@1"
	}
	prompts := CapabilityPrompts(CapabilityPromptsInput{
		DefinitionVersion: definitionVersion, Action: options.Action, Role: options.Role, AgentPrompt: loaded.Prompts.Agent, Report: filtered, Tools: selected.Tools,
	})
	toolNames := []any{}
	for _, tool := range selected.Tools {
		toolNames = append(toolNames, map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters})
	}
	grants := capabilitySortedCopy(capabilityUnique(options.Grants))
	extensions := capabilitySortedCopy(selected.ExtensionTools)
	toolPolicyDigest := capabilityBundleDigest(map[string]any{
		"bundleDigest": version.Digest, "readOnly": options.ReadOnly, "grants": grants, "tools": toolNames,
		"nativeTools": selected.NativeTools, "piExtensionTools": extensions,
	})
	runtimePolicyDigest := capabilityBundleDigest(map[string]any{
		"bundleRuntimePolicyDigest": version.RuntimePolicyDigest,
		"accessPolicyDigest":        capabilityAccessDigest(options.Access),
		"readOnly":                  options.ReadOnly,
		"piExtensionRuntime": map[string]any{
			"env": loaded.Env, "readRoots": readRoots, "writeRoots": loaded.WriteRoots, "networkDomains": loaded.NetworkDomains,
			"allowUnrestrictedNetwork": loaded.AllowUnrestrictedNetwork, "allowLocalBinding": loaded.AllowLocalBinding, "unixSockets": loaded.UnixSockets,
		},
	})
	serverNames := []string{}
	for _, server := range adapterServers {
		name := strings.TrimSpace(server.Name)
		if name != "" {
			serverNames = append(serverNames, name)
		}
	}
	allowed := []string{}
	for _, tool := range selected.Tools {
		allowed = append(allowed, tool.Name)
	}
	allowed = append(allowed, selected.NativeTools...)
	allowed = append(allowed, selected.ExtensionTools...)
	if len(serverNames) > 0 {
		allowed = append(allowed, MCP_ADAPTER_PROXY_TOOL)
	}
	allowed = capabilitySortedCopy(capabilityUnique(allowed))
	closeLoaded := loaded.Close
	operation = CapabilityOperation{
		Descriptor:   map[string]any{"definitionVersion": version.DefinitionVersion, "facts": capabilityCloneFacts(version.Facts), "settings": FreezeCapabilitySettings(map[string]any{"env": loaded.Env, "mcpAdapterServers": adapterServers}, secrets)},
		BundleDigest: version.Digest, ToolPolicyDigest: toolPolicyDigest, RuntimePolicyDigest: runtimePolicyDigest,
		LegacyPromptDigest: prompts.Digest, Tools: selected.Tools, NativeTools: append([]string{}, selected.NativeTools...),
		AllowedToolNames: allowed, Prompts: CapabilityOperationPrompts{System: prompts.SystemPrompt, Tool: loaded.Prompts.Tool},
		Report: filtered, SkillPaths: append([]string{}, loaded.SkillPaths...), SkillFolder: version.SkillFolder,
		ReadRoots: readRoots, WriteRoots: append([]string{}, loaded.WriteRoots...), Env: capabilityCopyEnv(loaded.Env),
		NetworkDomains: append([]string{}, loaded.NetworkDomains...), AllowUnrestrictedNetwork: loaded.AllowUnrestrictedNetwork,
		AllowLocalBinding: loaded.AllowLocalBinding, UnixSockets: append([]string{}, loaded.UnixSockets...),
		PiExtensionPaths: append([]string{}, loaded.PiExtensionPaths...), PiExtensionTools: append([]string{}, selected.ExtensionTools...),
		McpAdapterServers: append([]McpAdapterServerRef{}, adapterServers...),
		Close: func() {
			if closeLoaded != nil {
				closeLoaded()
			}
		},
	}
	return operation
}

type capabilityDeclaredTool struct {
	Name        string
	Description string
}

func capabilityDeclaredTools(fact ResolvedCapabilityFact) []capabilityDeclaredTool {
	record := asMap(fact)
	raw, _ := record["declaredTools"].([]any)
	if raw == nil {
		raw, _ = record["DeclaredTools"].([]any)
	}
	out := []capabilityDeclaredTool{}
	for _, item := range raw {
		tool, _ := item.(map[string]any)
		out = append(out, capabilityDeclaredTool{Name: mapString(tool, "name", "Name"), Description: mapString(tool, "description", "Description")})
	}
	return out
}

func capabilityFactKind(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "kind", "Kind")
}

func capabilityFactPath(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "path", "Path")
}

func capabilityFactName(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "name", "Name")
}

func capabilityPastedSkill(skill LoadedSkill) RuntimeCapabilityLoadFact {
	return capabilityFactFromMap(map[string]any{
		"id": skill.Name, "version": "local", "kind": "skill", "name": skill.Name, "description": skill.Description,
		"path": skill.FilePath, "loaded": true, "executable": false, "reason": "原生 skills 注入：模型按需读取 SKILL.md",
	})
}

func capabilityWithReason(fact RuntimeCapabilityLoadFact, reason string) RuntimeCapabilityLoadFact {
	record := asMap(fact)
	if record == nil {
		record = map[string]any{}
	}
	record["reason"] = reason
	return capabilityFactFromMap(record)
}

func capabilityFilterTools(fact RuntimeCapabilityLoadFact, disabled map[string]bool) RuntimeCapabilityLoadFact {
	record := asMap(fact)
	if record == nil {
		return fact
	}
	tools, ok := record["tools"].([]any)
	if !ok {
		return fact
	}
	kept := []any{}
	for _, tool := range tools {
		name, _ := tool.(string)
		if !disabled[name] {
			kept = append(kept, tool)
		}
	}
	record["tools"] = kept
	return capabilityFactFromMap(record)
}

func capabilityFactFromMap(record map[string]any) RuntimeCapabilityLoadFact {
	raw, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	var fact RuntimeCapabilityLoadFact
	if err := json.Unmarshal(raw, &fact); err != nil {
		panic(err)
	}
	return fact
}

func capabilityCopyEnv(env map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range env {
		out[key] = value
	}
	return out
}

func capabilityAccessDigest(access *ResolvedAccessPolicy) any {
	if access == nil {
		return nil
	}
	return access.Digest
}

// CapabilityLoadInput is the loader request for one operation.
type CapabilityLoadInput struct {
	FrozenFacts          []ResolvedCapabilityFact
	Catalog              *Catalog
	DefinitionVersion    string
	HasDefinitionVersion bool
	Workspace            string
	ScratchDir           string
	Gate                 SendGate
	Bootstrap            *CapabilityBootstrap
	McpDomains           []string
	Grants               []string
	ReadOnly             bool
	Secrets              map[string]string
	OnPermissionRequired func(CapabilityPermissionRequest)
	Access               *ResolvedAccessPolicy
}

// CapabilityPromptsInput builds the identity prompt from the loaded bundle.
type CapabilityPromptsInput struct {
	DefinitionVersion string
	Action            string
	Role              string
	AgentPrompt       *string
	Report            []RuntimeCapabilityLoadFact
	Tools             []ToolDefinition
}
