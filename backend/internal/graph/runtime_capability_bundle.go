package graph

import (
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"

	"crypto/sha256"
)

func capabilityBundleDigest(value any) string {
	sum := sha256.Sum256([]byte(CanonicalJSON(value)))
	return hex.EncodeToString(sum[:])
}

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

type CapabilityBootstrap struct {
	Agent string
	Tool  string
}

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
	// NativeToolsProvider builds the native tools the granted native names
	// stand for. It is set when the kernel runs without an SDK of its own:
	// the TypeScript SDK provided read, write, edit, ls, find, grep and the
	// shell, and nothing replaces them on the PiG kernel but the daemon.
	NativeToolsProvider func(granted []string) []ToolDefinition
}

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
	McpServers        []McpServerRef
	Close                    func()
}

type CapabilityOperationPrompts struct {
	System string
	Tool   *string
}

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
	facts := []McpFact{}
	for _, fact := range version.Facts {
		role := fact.Role
		if role == "" {
			role = "tool"
		}
		facts = append(facts, McpFact{Id: fact.Id, Version: fact.Version, Kind: fact.Kind, Path: fact.Path, Role: role})
	}
	secrets := map[string]string{}
	if version.input.Secrets != nil {
		secrets = version.input.Secrets()
	}
	adapterServers := McpServersFor(facts, secrets)
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
	if options.NativeToolsProvider != nil {
		// The native tools stand in for the Graph tools they supersede: they
		// carry the names the SDK published, so the model's prompt and its
		// habits hold, and the digest covers the surface the session really has.
		native := options.NativeToolsProvider(selected.NativeTools)
		for _, tool := range native {
			if !capabilityToolAllowed(tool.Name, selected.Tools) {
				selected.Tools = append(selected.Tools, tool)
			}
		}
		sort.SliceStable(selected.Tools, func(left, right int) bool {
			return selected.Tools[left].Name < selected.Tools[right].Name
		})
	}
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
	allowed = capabilitySortedCopy(capabilityUnique(allowed))
	closeLoaded := loaded.Close
	operation = CapabilityOperation{
		Descriptor:   map[string]any{"definitionVersion": version.DefinitionVersion, "facts": capabilityCloneFacts(version.Facts), "settings": FreezeCapabilitySettings(map[string]any{"env": loaded.Env, "mcpServers": adapterServers}, secrets)},
		BundleDigest: version.Digest, ToolPolicyDigest: toolPolicyDigest, RuntimePolicyDigest: runtimePolicyDigest,
		LegacyPromptDigest: prompts.Digest, Tools: selected.Tools, NativeTools: append([]string{}, selected.NativeTools...),
		AllowedToolNames: allowed, Prompts: CapabilityOperationPrompts{System: prompts.SystemPrompt, Tool: loaded.Prompts.Tool},
		Report: filtered, SkillPaths: append([]string{}, loaded.SkillPaths...), SkillFolder: version.SkillFolder,
		ReadRoots: readRoots, WriteRoots: append([]string{}, loaded.WriteRoots...), Env: capabilityCopyEnv(loaded.Env),
		NetworkDomains: append([]string{}, loaded.NetworkDomains...), AllowUnrestrictedNetwork: loaded.AllowUnrestrictedNetwork,
		AllowLocalBinding: loaded.AllowLocalBinding, UnixSockets: append([]string{}, loaded.UnixSockets...),
		PiExtensionPaths: append([]string{}, loaded.PiExtensionPaths...), PiExtensionTools: append([]string{}, selected.ExtensionTools...),
		McpServers: append([]McpServerRef{}, adapterServers...),
		Close: func() {
			if closeLoaded != nil {
				closeLoaded()
			}
		},
	}
	return operation
}

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

type CapabilityPromptsInput struct {
	DefinitionVersion string
	Action            string
	Role              string
	AgentPrompt       *string
	Report            []RuntimeCapabilityLoadFact
	Tools             []ToolDefinition
}
