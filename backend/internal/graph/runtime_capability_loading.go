package graph

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LoadCapabilities loads the capabilities bound by an Agent definition version.
//
// Skills become Pi resources and a read-only tool; local MCP servers and
// extensions run one restricted process per call; remote MCP talks to a host in
// the runtime's granted domains. Every tool call passes the same send gate as
// model calls.
func LoadCapabilities(input CapabilityLoadInput) LoadedCapabilities {
	state := &capabilityLoadState{
		skillPaths: []string{}, piExtensionPaths: []string{}, piExtensionTools: []string{},
		readRoots: []string{}, writeRoots: []string{}, env: map[string]string{},
		runtimeNetworkDomains: []string{}, runtimeUnixSockets: []string{}, tools: []ToolDefinition{},
	}
	if input.Bootstrap != nil {
		state.agentPrompt = strings.TrimSpace(input.Bootstrap.Agent)
		state.toolPrompt = strings.TrimSpace(input.Bootstrap.Tool)
	}
	// Actual load facts: later projections must never guess these from catalog
	// status alone.
	report := []RuntimeCapabilityLoadFact{}
	closeLoaded := func() {
		for index := len(state.releases) - 1; index >= 0; index-- {
			state.releases[index]()
		}
		state.releases = []func(){}
	}
	digest := func() string {
		stable := []any{}
		for _, fact := range report {
			stable = append(stable, capabilityStableFact(fact))
		}
		toolFacts := []any{}
		for _, tool := range state.tools {
			toolFacts = append(toolFacts, map[string]any{
				"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters,
			})
		}
		var definitionVersion any
		if input.HasDefinitionVersion {
			definitionVersion = input.DefinitionVersion
		}
		var agent any
		if state.agentPrompt != "" {
			agent = state.agentPrompt
		}
		var tool any
		if state.toolPrompt != "" {
			tool = state.toolPrompt
		}
		return capabilityTextDigest(CanonicalJSON(map[string]any{
			"definitionVersion":        definitionVersion,
			"report":                   stable,
			"skillPaths":               state.skillPaths,
			"piExtensionPaths":         state.piExtensionPaths,
			"piExtensionTools":         state.piExtensionTools,
			"writeRoots":               state.writeRoots,
			"env":                      state.env,
			"networkDomains":           state.runtimeNetworkDomains,
			"allowUnrestrictedNetwork": state.runtimeUnrestrictedNetwork,
			"allowLocalBinding":        state.runtimeLocalBinding,
			"unixSockets":              state.runtimeUnixSockets,
			"prompts": map[string]any{
				"agent": agent,
				"tool":  tool,
			},
			"tools": toolFacts,
		}))
	}
	finish := func() LoadedCapabilities {
		return LoadedCapabilities{
			SkillPaths: state.skillPaths, PiExtensionPaths: state.piExtensionPaths, PiExtensionTools: state.piExtensionTools,
			ReadRoots: state.readRoots, WriteRoots: state.writeRoots, Env: state.env,
			NetworkDomains: state.runtimeNetworkDomains, AllowUnrestrictedNetwork: state.runtimeUnrestrictedNetwork,
			AllowLocalBinding: state.runtimeLocalBinding, UnixSockets: state.runtimeUnixSockets,
			Tools:   state.tools,
			Prompts: LoadedCapabilityPrompts{Agent: capabilityOptionalString(state.agentPrompt), Tool: capabilityOptionalString(state.toolPrompt)},
			Digest:  digest(), Close: closeLoaded, Report: report,
		}
	}
	if !input.HasDefinitionVersion || input.DefinitionVersion == "" {
		return finish()
	}
	definition, found := capabilityDefinition(input.Catalog, input.DefinitionVersion)
	if input.FrozenFacts != nil {
		definition = CatalogDefinition{}
		for _, fact := range input.FrozenFacts {
			definition.Capabilities = append(definition.Capabilities, CapabilityBinding{Id: fact.Id, Version: fact.Version})
		}
		found = true
	}
	if !found {
		// Unpublished definitions keep briefing-only behavior.
		return finish()
	}
	bindings := capabilityDefinitionBindings(definition, input.Catalog)
	if input.FrozenFacts != nil {
		bindings = nil
		for _, fact := range input.FrozenFacts {
			role := capabilityRoleCapability
			if fact.Kind == "prompt" && fact.Role == "agent" {
				role = capabilityRoleAgent
			}
			if fact.Kind == "prompt" && fact.Role == "tool" {
				role = capabilityRoleTool
			}
			bindings = append(bindings, capabilityBinding{bound: CapabilityBinding{Id: fact.Id, Version: fact.Version}, role: role})
		}
	}
	// Bindings the definition declares itself are a promise to the user, so they stay fail-closed.
	// The rest come from base capabilities: a convenience layer nobody asked for, which must never
	// be able to stop a session (see the 2026-09-25 incident).
	declaredKeys := map[string]bool{}
	if input.FrozenFacts != nil {
		for _, binding := range bindings {
			declaredKeys[capabilityBindingKey(binding.bound, string(binding.role))] = true
		}
	}
	for _, binding := range definition.Capabilities {
		declaredKeys[capabilityBindingKey(binding, string(capabilityRoleCapability))] = true
	}
	if definition.Prompts != nil && definition.Prompts.Agent != nil {
		declaredKeys[capabilityBindingKey(*definition.Prompts.Agent, string(capabilityRoleAgent))] = true
	}
	if definition.Prompts != nil && definition.Prompts.Tool != nil {
		declaredKeys[capabilityBindingKey(*definition.Prompts.Tool, string(capabilityRoleTool))] = true
	}
	seen := map[string]bool{}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				closeLoaded()
				panic(recovered)
			}
		}()
		for _, binding := range bindings {
			seenKey := capabilityBindingKey(binding.bound, string(binding.role))
			if seen[seenKey] {
				continue
			}
			seen[seenKey] = true
			facts, failure := capabilityLoadOne(input, binding, state)
			if failure != nil {
				if declaredKeys[seenKey] {
					panic(failure)
				}
				kind := ""
				if record := capabilityInputRecord(input, binding); record != nil {
					kind = record.Kind
				}
				report = append(report, RuntimeCapabilityLoadFact{
					Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(kind),
					Loaded: false, Executable: false,
					Reason: capabilityOptionalString("基础能力加载失败，已跳过（它不在本 Agent 的配方里）：" + capabilityFailureMessage(failure)),
				})
				continue
			}
			report = append(report, facts...)
		}
	}()
	if input.Access != nil && input.Access.Network == "unrestricted" {
		state.runtimeNetworkDomains = []string{}
		state.runtimeUnrestrictedNetwork = true
	}
	if input.Access != nil && input.Access.PiExtensions.LocalBinding {
		state.runtimeLocalBinding = true
	}
	return finish()
}

// capabilityFailureMessage reads the message of one load failure.
func capabilityFailureMessage(failure any) string {
	if err, ok := failure.(*RuntimeError); ok && err != nil {
		return err.Message
	}
	if err, ok := failure.(error); ok {
		return err.Error()
	}
	return fmt.Sprintf("%v", failure)
}

// capabilityOptionalString turns an empty text into an absent value.
func capabilityOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	text := value
	return &text
}

// capabilityLoadOne loads one bound capability. It returns the facts it produced, or the
// failure that stopped it.
func capabilityLoadOne(input CapabilityLoadInput, binding capabilityBinding, state *capabilityLoadState) ([]RuntimeCapabilityLoadFact, any) {
	record := capabilityInputRecord(input, binding)
	if record == nil || record.Status != "available" {
		Raise("capability_unavailable", "Capability "+binding.bound.Id+"@"+binding.bound.Version+" is not available in the capability directory")
	}
	snapshot := capabilitySnapshotPath(record)
	if record.Kind == CapabilityKindPrompt {
		if binding.role == capabilityRoleCapability {
			Raise("capability_unsupported", "Prompt capability "+binding.bound.Id+"@"+binding.bound.Version+" must be bound under prompts")
		}
		file := "tool.md"
		if binding.role == capabilityRoleAgent {
			file = "agent.md"
		}
		text := capabilityPromptText(snapshot, file)
		if binding.role == capabilityRoleAgent {
			state.agentPrompt = text
		} else {
			parts := []string{}
			if state.toolPrompt != "" {
				parts = append(parts, state.toolPrompt)
			}
			parts = append(parts, text)
			state.toolPrompt = strings.Join(parts, "\n\n")
		}
		reason := "能力感知 Prompt 已注入"
		if binding.role == capabilityRoleAgent {
			reason = "身份 Prompt 已注入"
		}
		return []RuntimeCapabilityLoadFact{{
			Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
			Loaded: true, Executable: false, Reason: capabilityOptionalString(reason),
		}}, nil
	}
	if binding.role != capabilityRoleCapability {
		Raise("capability_unsupported", string(binding.role)+" prompt binding "+binding.bound.Id+"@"+binding.bound.Version+" is not a prompt capability")
	}
	if record.Kind == CapabilityKindSkill {
		skillFile := filepath.Join(snapshot, "SKILL.md")
		if _, err := os.Stat(skillFile); err != nil {
			Raise("capability_unavailable", "Skill "+binding.bound.Id+"@"+binding.bound.Version+" has no SKILL.md")
		}
		body, err := os.ReadFile(skillFile)
		if err != nil {
			panic(err)
		}
		metadata := capabilitySkillMetadata(string(body))
		state.skillPaths = append(state.skillPaths, snapshot)
		state.readRoots = append(state.readRoots, snapshot)
		fact := RuntimeCapabilityLoadFact{
			Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
			Loaded: true, Executable: false,
			Reason: capabilityOptionalString("原生 skills 注入：模型按需读取 SKILL.md"),
			Path:   capabilityOptionalString(skillFile),
		}
		if name, ok := metadata["name"]; ok {
			fact.Name = capabilityOptionalString(name)
		}
		if description, ok := metadata["description"]; ok {
			fact.Description = capabilityOptionalString(description)
		}
		return []RuntimeCapabilityLoadFact{fact}, nil
	}
	if record.Kind == CapabilityKindPiExtension {
		return capabilityLoadPiExtension(input, binding, record, snapshot, state)
	}
	if record.Kind != CapabilityKindMCP && record.Kind != CapabilityKindExtension {
		Raise("capability_unsupported", "Capability kind "+record.Kind+" is not loadable")
	}
	manifest := capabilityManifestOf(snapshot)
	var connection McpExchange
	var authorization *capabilityAuthorization
	loadedReason := ""
	var networkDomains []string
	var networkAccess string
	var provisioning *capabilityProvisioningPlan
	if record.Kind == CapabilityKindExtension {
		lease := AcquireRestrictedExecutor()
		executor, ok := capabilityRestrictedExecutorOf(lease.Executor)
		if !ok {
			Raise("capability_unavailable", "the restricted executor does not run restricted commands")
		}
		state.releases = append(state.releases, lease.Release)
		connection = capabilityExtensionConnection(capabilityExtensionConnectionInput{
			executor: executor, gate: input.Gate, manifest: manifest, snapshot: snapshot,
			workspace: input.Workspace, scratchDir: input.ScratchDir, readOnly: input.ReadOnly, access: input.Access,
		})
		if input.ReadOnly {
			loadedReason = "只读讨论模式：本地扩展在 scratch 只读范围加载"
		}
	} else if _, ok := manifest["command"].(string); ok {
		fullNetwork := input.Access != nil && input.Access.Network == "unrestricted"
		if !fullNetwork && manifest["networkAccess"] != nil && manifest["networkAccess"] != "unrestricted" {
			Raise("capability_unavailable", "MCP networkAccess must be \"unrestricted\"")
		}
		if fullNetwork || manifest["networkAccess"] == "unrestricted" {
			networkAccess = "unrestricted"
		}
		if !fullNetwork && networkAccess != "" && manifest["networkDomains"] != nil {
			Raise("capability_unavailable", "MCP cannot combine networkDomains with unrestricted network access")
		}
		if networkAccess == "" {
			networkDomains = capabilityManifestNetworkDomains(manifest, input.McpDomains, input.Secrets)
		} else {
			networkDomains = []string{}
		}
		if len(networkDomains) > 0 || networkAccess != "" {
			authorization = &capabilityAuthorization{grants: input.Grants, onPermissionRequired: input.OnPermissionRequired}
		}
		plan, err := capabilityEnsureMcpProvisioned(input.Gate, manifest, snapshot, input.Workspace, input.ScratchDir, input.Secrets, networkDomains,
			input.Access != nil && input.Access.Commands == "host", fullNetwork, input.Access)
		if err != nil {
			Raise("capability_unavailable", err.Error())
		}
		provisioning = plan
		lease := AcquireRestrictedExecutor()
		executor, ok := capabilityRestrictedExecutorOf(lease.Executor)
		if !ok {
			Raise("capability_unavailable", "the restricted executor does not run restricted commands")
		}
		state.releases = append(state.releases, lease.Release)
		connection = capabilityLocalConnection(capabilityLocalConnectionInput{
			executor: executor, gate: input.Gate, manifest: manifest, snapshot: snapshot,
			workspace: input.Workspace, scratchDir: input.ScratchDir, readOnly: input.ReadOnly,
			networkDomains: networkDomains, allowUnrestrictedNetwork: networkAccess != "",
			access: input.Access, secrets: input.Secrets, provisioning: provisioning, provisioningPhase: "runtime",
			hostCommands: input.Access != nil && input.Access.Commands == "host",
		})
		if input.ReadOnly {
			loadedReason = "只读讨论模式：本地能力在只读范围加载"
		}
	} else {
		if manifest["networkAccess"] != nil {
			Raise("capability_unavailable", "MCP networkAccess is only valid for local MCP commands")
		}
		authorization = &capabilityAuthorization{grants: input.Grants, onPermissionRequired: input.OnPermissionRequired}
		connection = capabilityRemoteConnection(manifest, input.Gate, input.McpDomains, input.Secrets)
		remote, _ := manifest["url"].(string)
		parsed, err := url.Parse(remote)
		hostname := ""
		if err == nil {
			hostname = parsed.Hostname()
		}
		networkDomains = capabilityManifestNetworkDomains(manifest, append(append([]string{}, input.McpDomains...), hostname), input.Secrets)
	}
	discovered := ListMcpTools(connection)
	if authorization != nil {
		// Binding a capability to the Agent definition is the default
		// authorization boundary. Keep explicit task grants as additional
		// evidence, but do not require a second per-tool approval for tools
		// that are already present in the bound, versioned capability.
		grants := append([]string{}, authorization.grants...)
		for _, tool := range discovered {
			grants = append(grants, McpGrant(binding.bound.Id, tool.Name))
		}
		sort.Strings(grants)
		authorization.grants = capabilityUniqueStrings(grants)
	}
	state.tools = append(state.tools, capabilityTools(connection, discovered, binding.bound.Id, binding.bound.Version, authorization)...)
	// "Loaded" is discovery; "executable" reflects the effective grants
	// assembled for this operation.
	executable := true
	grantReason := ""
	if authorization != nil && len(discovered) > 0 {
		granted := 0
		for _, tool := range discovered {
			if capabilityStringListHas(authorization.grants, McpGrant(binding.bound.Id, tool.Name)) {
				granted++
			}
		}
		executable = granted > 0
		if granted == 0 {
			grantReason = "已加载 " + itoa(len(discovered)) + " 个工具，当前无任务授权（例如 " + McpGrant(binding.bound.Id, discovered[0].Name) + "），调用会被权限门拒绝"
		} else if granted < len(discovered) {
			grantReason = "已加载 " + itoa(len(discovered)) + " 个工具，其中 " + itoa(granted) + " 个获授权，其余调用会被权限门拒绝"
		}
	} else if authorization != nil && len(discovered) == 0 {
		executable = false
		grantReason = "能力已连接但没有可调用工具"
	}
	fact := RuntimeCapabilityLoadFact{
		Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
		Loaded: true, Executable: executable,
	}
	if grantReason != "" {
		fact.Reason = capabilityOptionalString(grantReason)
	} else if loadedReason != "" {
		fact.Reason = capabilityOptionalString(loadedReason)
	}
	if len(discovered) > 0 {
		names := []string{}
		for _, tool := range discovered {
			names = append(names, capabilityMcpToolName(binding.bound.Id, tool.Name))
		}
		fact.Tools = names
	}
	if len(networkDomains) > 0 {
		fact.NetworkDomains = networkDomains
	}
	if networkAccess != "" {
		fact.NetworkAccess = networkAccess
	}
	if provisioning != nil {
		fact.Provisioning = &RuntimeCapabilityProvisioning{
			Manager: provisioning.manager, Domains: provisioning.domains, Path: provisioning.root,
		}
	}
	return []RuntimeCapabilityLoadFact{fact}, nil
}
