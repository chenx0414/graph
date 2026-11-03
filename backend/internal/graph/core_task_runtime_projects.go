package graph

import (
	"path/filepath"
	"sort"
	"strings"
)

// Prepare authorizes the Git preparation of one project.
func (runtime *TaskRuntime) Prepare(input TaskRuntimeProjectPrepareInput) any {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[input.ProjectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	payload := map[string]any{
		"type": "prepare", "projectId": input.ProjectId, "initialize": input.Initialize, "createBaseline": input.CreateBaseline,
	}
	encoded := CanonicalJSON(payload)
	previous := kernelRow(runtime.store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", "projects", input.RequestId)
	if previous != nil {
		if kernelString(previous["payload"]) != encoded {
			Raise("idempotency_conflict", "requestId was already used with different content")
		}
		return parseJSON(kernelString(previous["receipt"]))
	}
	opId := graphUUID()
	headBefore := runtime.git.ProjectHead(input.ProjectId)
	fingerprintBefore := runtime.git.ProjectFingerprint(input.ProjectId)
	runtime.store.Transaction(func() any {
		RecordGitOperation(runtime.store, opId, "project:"+input.ProjectId, "prepare", "intent",
			CanonicalJSON(map[string]any{"payload": payload, "requestId": input.RequestId, "headBefore": headBefore, "fingerprintBefore": fingerprintBefore}))
		return nil
	})
	prep := runtime.git.PrepareProject(input.ProjectId, input.Initialize, input.CreateBaseline)
	if prep == nil {
		Raise("invalid_graph", "The project could not be prepared")
	}
	return runtime.settlePrepare(opId, input.RequestId, payload, prep, map[string]any{"state": prep.State, "baselineSha": prep.BaselineSha})
}

// settlePrepare persists the settled prepare receipt idempotently.
func (runtime *TaskRuntime) settlePrepare(opId, requestId string, payload map[string]any, prep *ProjectPreparation, result map[string]any) any {
	encoded := CanonicalJSON(payload)
	return runtime.store.Transaction(func() any {
		SettleGitOperation(runtime.store, opId, "succeeded", CanonicalJSON(result))
		duplicate := kernelRow(runtime.store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", "projects", requestId)
		if duplicate != nil {
			if kernelString(duplicate["payload"]) != encoded {
				Raise("idempotency_conflict", "requestId was already used with different content")
			}
			return parseJSON(kernelString(duplicate["receipt"]))
		}
		receipt := map[string]any{
			"state":       prep.State,
			"baselineSha": prep.BaselineSha,
			"cursor":      runtime.store.Event(nil, "project.prepared", map[string]any{"projectId": payload["projectId"], "state": prep.State, "baselineSha": prep.BaselineSha}),
		}
		runtime.store.RecordCommand("projects", requestId, encoded, CanonicalJSON(receipt))
		return receipt
	})
}

// Preparation reads the recorded preparation of one project.
func (runtime *TaskRuntime) Preparation(projectId string) *ProjectPreparation {
	runtime.ensureOpen()
	prep := runtime.git.Preparation(projectId)
	if prep == nil {
		Raise("not_found", "No preparation recorded for "+projectId)
	}
	return prep
}

// Artifacts reads the artifact workspace of the runtime.
func (runtime *TaskRuntime) Artifacts() *ArtifactWorkspace {
	return runtime.artifacts
}

// ListConversationArtifacts lists the artifacts of every task of one conversation.
//
// Every task in the conversation sees the same project-scoped artifacts, so the union
// has to be deduplicated by artifact and version or a shared artifact would be listed
// once per task.
func (runtime *TaskRuntime) ListConversationArtifacts(conversationId string, query ArtifactQuery) ArtifactPage {
	seen := map[string]ArtifactRecord{}
	for _, taskId := range runtime.conversationTaskIds(conversationId) {
		scoped := query
		scoped.TaskId = taskId
		limit := 200
		scoped.Limit = &limit
		for _, record := range runtime.artifacts.List(scoped).Artifacts {
			seen[record.ArtifactId+"@"+itoa(record.Version)] = record
		}
	}
	records := make([]ArtifactRecord, 0, len(seen))
	for _, record := range seen {
		records = append(records, record)
	}
	sort.Slice(records, func(left, right int) bool { return records[left].CreatedAt > records[right].CreatedAt })
	limit := 100
	if query.Limit != nil {
		limit = *query.Limit
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	if limit > len(records) {
		limit = len(records)
	}
	return ArtifactPage{Artifacts: records[:limit], NextCursor: nil, Total: len(records)}
}

// Catalog reads the capability catalog of the runtime.
func (runtime *TaskRuntime) Catalog() *Catalog {
	return runtime.catalog
}

// Talent is the definition detail plus the per-metric experience statistics from the
// ledger.
func (runtime *TaskRuntime) Talent(id string, version *int, allVersions bool) any {
	runtime.ensureOpen()
	return map[string]any{
		"detail": TalentDetail(runtime.store, id, version, func(capabilityId, capabilityVersion string) *CapabilityRecord {
			return runtime.catalog.Capability(capabilityId, capabilityVersion)
		}),
		"experience": TalentExperienceOf(runtime.store, id, version, allVersions),
	}
}

// ControlGraph applies one graph control action.
// CreateGraph creates a graph on behalf of a conversation.
//
// The graph's owner is the conversation's own task, which is exactly what
// happens when the main Agent calls graph_create: a console caller may start a
// graph without a model turn, and the ownership it records is the same one an
// Agent-created graph would record. An unknown conversation is refused rather
// than attached to a guess.
func (runtime *TaskRuntime) CreateGraph(conversationId string, input map[string]any) any {
	runtime.ensureOpen()
	owner := ConversationRowOf(runtime.store, conversationId).AnchorTaskId
	if strings.TrimSpace(owner) == "" {
		Raise("invalid_input", "A graph needs the conversation that owns it: "+conversationId)
	}
	result := runtime.graphManagement(owner).GraphCreate(input)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return result
}

func (runtime *TaskRuntime) ControlGraph(taskId string, input GraphControlInput) any {
	runtime.ensureOpen()
	if input.Action == "stop_node" || input.Action == "steer_node" {
		if input.NodeId == nil || strings.TrimSpace(*input.NodeId) == "" || input.RequestID == "" || len(input.RequestID) > 200 {
			Raise("invalid_input", "A node and bounded requestId are required")
		}
		if input.Action == "stop_node" {
			return runtime.stopGraphNode("user:"+taskId, taskId, strings.TrimSpace(*input.NodeId), input.RequestID)
		}
		if strings.TrimSpace(input.Text) == "" {
			Raise("invalid_input", "A nonempty steering message is required")
		}
		return runtime.steerGraphNode("user:"+taskId, taskId, strings.TrimSpace(*input.NodeId), strings.TrimSpace(input.Text), input.RequestID)
	}
	payload := map[string]any{"graphId": taskId, "action": input.Action}
	if input.Proof != "" {
		payload["proof"] = input.Proof
	}
	if input.NodeId != nil {
		payload["nodeId"] = *input.NodeId
	}
	if input.ModuleId != nil {
		payload["moduleId"] = *input.ModuleId
	}
	if input.Seq != nil {
		payload["seq"] = *input.Seq
	}
	if input.OperationId != nil {
		payload["operationId"] = *input.OperationId
	}
	if input.CallId != nil {
		payload["callId"] = *input.CallId
	}
	if input.Usage != nil {
		payload["usage"] = map[string]any{"input": input.Usage.Input, "output": input.Usage.Output, "cacheRead": input.Usage.CacheRead, "cacheWrite": input.Usage.CacheWrite}
	}
	if len(input.Limitations) > 0 {
		payload["limitations"] = input.Limitations
	}
	if input.RequestID != "" {
		// The console door names its request too, so a retried control action
		// replays its receipt instead of doing the same thing twice.
		payload["requestId"] = input.RequestID
	}
	result := runtime.graphManagement(taskId).GraphControl(payload)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return result
}

// WaiveAcceptance records the user's own waiver of one acceptance item.
//
// It is not a graph control action: graph_control runs as the Agent, and the
// service refuses a human acceptance item for any actor that is not the user. The
// record it appends is the same append-only ledger an Agent's limitation goes
// into, so one read shows every decision a closure rests on.
func (runtime *TaskRuntime) WaiveAcceptance(taskId string, input GraphAcceptanceWaiveInput) any {
	runtime.ensureOpen()
	input.GraphId = taskId
	result := runtime.graphService(taskId).WaiveAcceptance(input)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return result
}

// PiExtensionUpdates lists the Pi extension sources that have a newer version than the
// one on disk.
//
// A source that cannot be inspected is reported with its error, never dropped: "we could
// not look" and "the extension is current" are different facts.
func (runtime *TaskRuntime) PiExtensionUpdates() any {
	runtime.ensureOpen()
	updates := []PiExtensionUpdate{}
	for _, record := range runtime.catalog.Capabilities() {
		if record.Kind != "pi-extension" || record.Status != "available" || record.PackageSource == nil {
			continue
		}
		source := *record.PackageSource
		update := PiExtensionUpdate{Id: record.Id, Version: record.Version, Source: source}
		status, err := ResolvePiExtensionSourceStatus(PiExtensionSourceInput{
			Source: source, Cwd: runtime.stateDir, AgentDir: PiExtensionCacheDir(runtime.catalog),
		})
		if err != nil {
			message := err.Error()
			update.Error = &message
			update.Installed = nil
			update.Latest = nil
			update.Available = false
			update.InstallGaps = []string{}
			updates = append(updates, update)
			continue
		}
		update.PiExtensionSourceStatus = status
		updates = append(updates, update)
	}
	return map[string]any{"updates": updates}
}

// UpdatePiExtension installs or upgrades one Pi extension source, then rescans the
// capability library.
func (runtime *TaskRuntime) UpdatePiExtension(id string, version string) any {
	runtime.ensureOpen()
	record := runtime.catalog.Capability(id, version)
	if record == nil || record.PackageSource == nil || *record.PackageSource == "" {
		Raise("not_found", "Pi extension "+id+"@"+version+" has no package source")
	}
	result, err := UpdatePiExtensionSource(PiExtensionSourceInput{
		Source: *record.PackageSource, Cwd: runtime.stateDir, AgentDir: PiExtensionCacheDir(runtime.catalog),
	})
	if err != nil {
		panic(err)
	}
	SyncCapabilityVersion(record.Source, result.Version)
	runtime.catalog.Refresh()
	return result
}

// AgentContextPreview is the prompt library view of the next main Agent turn.
//
// The master follows the latest definition of its own recipe on the next turn, so the
// preview has to describe that same version instead of the one the instance last ran.
func (runtime *TaskRuntime) AgentContextPreview(conversationId *string) any {
	runtime.ensureOpen()
	library := runtime.agentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	var view map[string]any
	if conversationId != nil && *conversationId != "" {
		limit := float64(1)
		view = runtime.Conversations().View(*conversationId, NodeEntryQuery{Limit: &limit})
	}
	definitions := runtime.catalog.ListDefinitions()
	latestDefinitionVersion := ""
	if runtime.master != nil && runtime.master.DefinitionVersion != nil {
		latestDefinitionVersion = runtime.master.DefinitionVersion()
	}
	if latestDefinitionVersion == "" {
		for _, item := range definitions {
			if item.Id == "main" {
				latestDefinitionVersion = "main@" + itoa(int(item.Version))
				break
			}
		}
	}
	if latestDefinitionVersion == "" {
		for _, item := range definitions {
			if item.Id == "master" {
				latestDefinitionVersion = "master@" + itoa(int(item.Version))
				break
			}
		}
	}
	masterVersion := ""
	masterId := ""
	if master, ok := view["master"].(map[string]any); ok && master != nil {
		masterVersion, _ = master["definitionVersion"].(string)
	}
	if masterVersion != "" {
		masterId = strings.Split(masterVersion, "@")[0]
	}
	definitionVersion := masterVersion
	if masterId != "" {
		for _, item := range definitions {
			if item.Id == masterId {
				definitionVersion = masterId + "@" + itoa(int(item.Version))
				break
			}
		}
	}
	if definitionVersion == "" {
		definitionVersion = latestDefinitionVersion
	}
	definitionId := ""
	if definitionVersion != "" {
		definitionId = strings.Split(definitionVersion, "@")[0]
	}
	action := "master"
	if runtime.master != nil && runtime.master.Action != "" {
		action = runtime.master.Action
	}
	projectRoot := ""
	if view != nil {
		projectRoot, _ = view["projectRoot"].(string)
	}
	workspace := projectRoot
	if view != nil {
		master, _ := view["master"].(map[string]any)
		anchor, _ := view["anchorTaskId"].(string)
		if master != nil && anchor != "" {
			nodeId, _ := master["nodeId"].(string)
			if resolved := runtime.AgentWorkspace(anchor, nodeId); resolved != nil && *resolved != "" {
				workspace = *resolved
			}
		}
	}
	fullAccess := IsFullAccess(runtime.CurrentAccessPolicy())
	rsiAvailable := false
	if runtime.rsi != nil {
		rsiAvailable = runtime.rsi.Status(false).Available
	}
	assemblyInput := AgentContextAssemblyOptions{
		CapabilityBundleOptions: CapabilityBundleOptions{
			Catalog: runtime.catalog, DefinitionVersion: definitionVersion,
			SkillProjectRoot: projectRoot,
		},
		Action: action, Role: "master", Runtime: "node", Workspace: workspace,
		Library: library, FullAccess: fullAccess, Retrieval: true,
		Rsi: rsiAvailable && fullAccess,
	}
	if runtime.catalogOpt != nil {
		if prompt, ok := runtime.catalogOpt.BootstrapPrompts[definitionId]; ok && prompt != "" {
			assemblyInput.Bootstrap = &CapabilityBootstrap{Agent: prompt}
		}
		if runtime.catalogOpt.BootstrapToolPrompt != "" {
			if assemblyInput.Bootstrap == nil {
				assemblyInput.Bootstrap = &CapabilityBootstrap{}
			}
			assemblyInput.Bootstrap.Tool = runtime.catalogOpt.BootstrapToolPrompt
		}
	}
	capabilityRoot := runtime.catalog.CapabilityRootPath()
	if definitionId != "" && capabilityRoot != "" {
		assemblyInput.SkillFolder = AgentSkillsDir(definitionId, filepath.Dir(capabilityRoot))
		assemblyInput.SkillOwnedRoots = AgentSkillOwnedRoots(capabilityRoot, runtime.stateDir)
	}
	assembly := OpenAgentContextAssembly(assemblyInput)
	features := AgentToolFeatures{
		Role: "master", Run: true, AskUser: true, Fetch: true, Catalog: true, GraphManagement: true,
		Conversations: &AgentConversationFeatures{Read: true, Write: true},
		Peers:         false,
		Artifacts:     agentArtifactAccessForPreview(action),
		Supervisor: &AgentSupervisorFeatures{
			ValidateProposal: true, GraphState: true, TaskStatus: true, ListProjects: true,
			BindProject: true, ListProblems: true, ResolveProblem: true, WithdrawDraft: true,
			ConfirmDraft: true, ArchiveDraft: true, RestoreDraft: true, DeleteDraft: true,
			PendingHumanChecks: true, ReviewHumanCheck: true, ControlTask: true,
		},
	}
	if conversationId != nil && *conversationId != "" {
		conversation := ConversationRowOf(runtime.store, *conversationId)
		switch conversation.Role {
		case ConversationGlobal:
			features.Supervisor.ResumeWork = true
			features.Supervisor.DelegateWork = true
			features.Supervisor.ReadWorkDraft = true
			features.Supervisor.BindProject = false
		case ConversationProject:
			features.Supervisor.ResumeWork = true
			features.AskUser = false
			features.AskSupervisor = true
			features.Supervisor.ProposeWorkGraph = true
			features.Supervisor.ReadWorkDraft = true
		}
	}
	if runtime.systemCtx != nil {
		// The preview must say what the next turn really gets. The four system
		// tools travel together: the inventory, the health view, and the
		// proposal flow that asks a person before the host is changed.
		features.SystemContext = &AgentSystemFeatures{
			SystemSummary:       runtime.systemCtx.SystemSummary != nil,
			SystemDiagnostics:   true,
			ProposeSystemChange: true,
			ApplySystemChange:   true,
		}
	}
	if runtime.rsi != nil {
		features.Rsi = &AgentRsiFeatures{Status: fullAccess, Apply: rsiAvailable && fullAccess}
	}
	preview := assembly.Preview(features)
	libraryView := library.View(map[string]string{
		"models": "{{models}}", "requirementVersion": "{{requirementVersion}}",
		"fullAccessInstruction": "{{fullAccessInstruction}}", "retrievalNote": "{{retrievalNote}}",
	})
	answer := map[string]any{
		"root": libraryView.Root, "prompts": libraryView.Prompts,
		// A shipped rule that the effective library no longer carries is a rule
		// nobody is bound by, and nothing else in the product would say so.
		"ruleSeedGaps":      library.RuleSeedGaps(),
		"disabledTools":     assembly.DisabledTools,
		"docsRoot":          preview.DocsRoot,
		"definitionVersion": definitionVersion, "latestDefinitionVersion": latestDefinitionVersion,
		"tools": preview.Tools, "capabilities": preview.Capabilities,
		"sent": nil,
	}
	if view != nil {
		if anchor, _ := view["anchorTaskId"].(string); anchor != "" {
			if record := runtime.store.ConversationSystemPrompt(anchor); record != nil {
				tools := any(nil)
				if record.Tools.Valid {
					tools = record.Tools.String
				}
				answer["sent"] = map[string]any{
					"operationId": record.OperationID, "at": record.At,
					"text": record.Text, "tools": tools,
				}
			}
		}
	}
	return answer
}

// agentArtifactAccessForPreview is the artifact surface the main Agent preview shows.
func agentArtifactAccessForPreview(action string) *AgentArtifactAccess {
	access := AgentArtifactAccessFor(struct {
		Role   string
		Action string
	}{Role: "master", Action: action})
	return &access
}
