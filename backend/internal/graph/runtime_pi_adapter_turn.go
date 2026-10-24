package graph

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// piAdapterPart is one live text part of one assistant message.
type piAdapterPart struct {
	entryId   string
	partId    string
	text      string
	buffer    string
	lastFlush int64
	ordinal   int
}

// PiAdapterToolActivity is one executed tool call in the turn record.
type PiAdapterToolActivity struct {
	ToolCallId string `json:"toolCallId"`
	Name       string `json:"name"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
}

// PiAdapterActivityRecord is one ordered turn activity entry.
type PiAdapterActivityRecord struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ToolCallId string `json:"toolCallId,omitempty"`
	Name       string `json:"name,omitempty"`
	Summary    string `json:"summary,omitempty"`
	State      string `json:"state,omitempty"`
	Ordinal    int    `json:"ordinal"`
}

// PiAdapterAskedQuestion is the agent's own question to the user.
type PiAdapterAskedQuestion struct {
	Prompt   string   `json:"prompt"`
	Why      string   `json:"why"`
	Options  []string `json:"options"`
	Multiple bool     `json:"multiple"`
}

// piAdapterRunTurn opens the session, sends the prompt and settles the operation.
func piAdapterRunTurn(options PiAdapterOptions, transport AgentSessionTransport, input piAdapterRunInput, turn piAdapterTurnInput) OperationResult {
	operation := input.Operation
	entry := input.Entry
	store := options.Store
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	// Context size comes from the last billed completion for this
	// instance, so Graph can compact before the window is exceeded
	// instead of waiting for a provider overflow.
	lastContextTokens := piAdapterLastContextTokens(store, operation.TaskId, instanceId)
	// The skills the session may read must match the block Graph renders: the bound
	// snapshots plus the SDK's own global and project folders.
	skillReadPaths := piAdapterUnique(append(append([]string{}, turn.CapabilityOperation.SkillPaths...),
		NativeSkillDirs([]string{turn.Workspace, input.ProjectRoot}, "", "")...))
	request := AgentSessionRequest{
		ExecutionConfiguration: map[string]any{"model": entry, "spec": turn.Spec, "accessPolicy": input.AccessPolicy},
		CapabilityDescriptor:   turn.CapabilityOperation.Descriptor,
		CredentialReference:    map[string]any{"modelId": entry.Id, "provider": entry.Provider, "credentialId": entry.CredentialId},
		ExecutionId:            operation.Id, InputRequestId: fmt.Sprintf("%s:attempt:%d", operation.Id, operation.Attempt),
		Binding: AgentSessionBinding{
			InstanceId: instanceId, NodeId: operation.NodeId, DefinitionVersion: input.DefinitionVersion,
		},
		// Durable telemetry for every tool call this instance executes, Graph's and Pi's alike.
		// The write is guarded here: a statistics table must never be able to break a turn.
		OnToolCall: func(call PiAdapterToolCall) {
			defer func() { _ = recover() }()
			target := any(nil)
			if call.Target != nil {
				target = call.Target
			}
			store.RecordToolCall(ToolCallInput{
				InstanceID: instanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: target,
			})
		},
		Workspace: turn.Workspace,
		StateDir:  filepath.Join(options.InstancesDir, instanceId),
		Model:     ToPiModel(entry),
		Stream: GuardHandoffResponses(
			ControlledOpenAIStream(turn.ObservedGate, entry, input.ResolveKeyFor, input.SlotFor, entry.Api, PiAdapterStreamOptions{
				EstimateMissing: UnknownUsageIsNonBlocking(store, instanceId),
				OnRequest: func(callId string, profile map[string]any) {
					data := map[string]any{
						"callId": callId, "operationId": operation.Id, "instanceId": instanceId, "model": entry.Id,
						"rates": nil, "pricing": nil,
					}
					if entry.Cost != nil {
						data["rates"] = entry.Cost
					}
					if entry.Pricing != nil {
						data["pricing"] = entry.Pricing
					}
					for key, value := range profile {
						data[key] = value
					}
					store.Event(operation.TaskId, "provider.request_profile", data)
				},
				OnSend: func(sent PiAdapterSentRequest) {
					if sent.SystemPrompt != nil {
						store.RecordOperationSystemPrompt(operation.Id, *sent.SystemPrompt, sent.ToolDeclarations)
					}
					// The site that records the truth also reports when a part of it is
					// gone: reporting only, a send is never blocked or rewritten.
					ReportPromptIntegrity(filepath.Join(options.InstancesDir, instanceId), operation.Id, sent.SystemPrompt, nil)
				},
			}),
			func() bool { return turn.Conversation != nil && !*turn.Compacting },
			func(status string) {
				store.Event(operation.TaskId, "session.handoff_response", map[string]any{
					"operationId": operation.Id, "nodeId": operation.NodeId, "status": status,
				})
			},
		),
		ThinkingLevel:    stringPointer(turn.ThinkingLevel),
		Tools:            turn.Tools,
		AllowedToolNames: append([]string{}, turn.CapabilityOperation.AllowedToolNames...),
		SkillPaths:       skillReadPaths,
		SkillFolder:      turn.CapabilityOperation.SkillFolder,
		ReadRoots:        append([]string{}, turn.CapabilityOperation.ReadRoots...),
		WriteRoots:       append([]string{}, turn.CapabilityOperation.WriteRoots...),
		Env:              turn.CapabilityOperation.Env,
		NetworkDomains:   append([]string{}, turn.CapabilityOperation.NetworkDomains...),
		AllowUnrestrictedNetwork: turn.CapabilityOperation.AllowUnrestrictedNetwork ||
			(input.AccessPolicy != nil && input.AccessPolicy.Network == "unrestricted"),
		AllowLocalBinding: turn.CapabilityOperation.AllowLocalBinding ||
			(input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.LocalBinding),
		UnixSockets:             append([]string{}, turn.CapabilityOperation.UnixSockets...),
		AllowAllUnixSockets:     input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.UnixSockets == "all",
		AllowAppleEvents:        input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.AppleEvents,
		PiExtensionPaths:        append([]string{}, turn.CapabilityOperation.PiExtensionPaths...),
		ExtensionProcessAllowed: pigExtensionProcessAllowed(input.AccessPolicy),
		McpAdapterServers:       append([]McpAdapterServerRef{}, turn.CapabilityOperation.McpAdapterServers...),
		PiExtensionTools:        append([]string{}, turn.CapabilityOperation.PiExtensionTools...),
		SystemPrompt:            turn.ComposedPrompt,
		BundleDigest:            turn.CapabilityOperation.BundleDigest,
		LegacyCapabilityDigest:  stringPointer(turn.CapabilityOperation.LegacyPromptDigest),
		ToolPolicyDigest:        turn.CapabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest:     turn.CapabilityOperation.RuntimePolicyDigest,
		Broker:                  turn.ObservedGate,
		NativeTools:             append([]string{}, turn.CapabilityOperation.NativeTools...),
		AllowWorkspaceChange:    turn.Conversation != nil,
		// Auto-compaction stays on for workers, reviewers and the master;
		// thresholds follow the model that will receive the summary.
		Compaction: piAdapterCompactionSettings(entry),
		OnEvent:    turn.OnEvent,
	}
	if input.AccessPolicy != nil {
		filesystemAccess := "bounded"
		if input.AccessPolicy.Filesystem.Read == "host" || input.AccessPolicy.Filesystem.Write == "host" {
			filesystemAccess = "host"
		}
		request.FilesystemAccess = filesystemAccess
		request.ProtectedPaths = input.AccessPolicy.ProtectedPaths
		request.AllowGitMetadataWritesAll = input.AccessPolicy.Filesystem.GitMetadata == "writable"
	}
	if turn.AgentContext != nil && turn.AgentContext.ReviewPolicy != nil {
		request.FreshSession = true
	}
	if options.RecoverySnapshot != nil {
		record := options.RecoverySnapshot.Record
		request.SystemPrompt = record.Agent.Instructions
		request.Model = record.Model
		request.Workspace = record.Policy.Workspace
		request.StateDir = record.Policy.StateDir
		request.InputRequestId = record.InputRequestId
		request.SkillPaths = record.Policy.SkillPaths
		request.SkillFolder = record.Policy.SkillFolder
		request.PiExtensionPaths = record.Policy.PiExtensionPaths
		request.ReadRoots = record.Policy.ReadRoots
		request.WriteRoots = record.Policy.WriteRoots
		request.ProtectedPaths = record.Policy.ProtectedPaths
		// The tools it was given are the ones the capability declared then.
		// A capability that declares a different tool since must not change
		// what this turn may call.
		request.PiExtensionTools = append([]string{}, record.Policy.PiExtensionTools...)
		request.AllowedToolNames = append([]string{}, record.Policy.AllowedToolNames...)
		request.BundleDigest = record.Policy.BundleDigest
		request.ToolPolicyDigest = record.Policy.ToolPolicyDigest
		request.RuntimePolicyDigest = record.Policy.RuntimePolicyDigest
		if record.Policy.ThinkingLevel != nil {
			request.ThinkingLevel = stringPointer(*record.Policy.ThinkingLevel)
		}
		request.CapabilityDescriptor = options.RecoverySnapshot.Descriptor
		request.ExecutionConfiguration = record.Configuration.ExecutionConfiguration
		request.CredentialReference = record.Configuration.CredentialReference
	}
	session, err := transport.Open(request)
	if err != nil {
		// A session that cannot be opened is a failed turn, not a crash.
		//
		// A crash here would leave the runtime with a turn it believes was
		// never sent: the node goes back to pending and the same turn is
		// dispatched again, forever, with the reason nowhere. A failed turn
		// says what happened and lets the user decide.
		if errors.Is(err, errPiExtensionNotHosted) {
			// The bound Pi extension could not be hosted for this session.
			// The model was never asked anything: the agent could not start
			// at all. That is a setup failure, and the runtime words it as
			// one - the message says the agent never came up, not that it ran
			// and gave up.
			return OperationResult{Outcome: "failed", Output: map[string]any{
				"setupError": piExtensionRefusalText(request.CapabilityDescriptor, request.PiExtensionPaths) + ": " + err.Error(),
			}, Usage: turn.Gate.Total()}
		}
		panic(err)
	}
	input.ActiveMu.Lock()
	(*input.ActiveInstances)[operation.Id] = session
	input.ActiveMu.Unlock()
	inspected := session.Inspect()
	if len(inspected.ExtensionErrors) > 0 {
		details := []string{}
		for _, item := range inspected.ExtensionErrors {
			details = append(details, fmt.Sprintf("%s: %v", item.Path, item.Error))
		}
		Raise("capability_unavailable", "A bound Pi extension failed to load: "+strings.Join(details, "; "))
	}
	if turn.PersistEntries {
		RecordNodeSession(store, instanceId, inspected.SessionId, inspected.SessionFile)
		if turn.AgentContext != nil {
			contextSession := PiAdapterContextSession{
				TaskId: operation.TaskId, NodeId: operation.NodeId, OperationId: operation.Id,
				BindingId: turn.AgentContext.BindingId, SessionId: inspected.SessionId,
				CapabilityDigest:  turn.CapabilityOperation.BundleDigest,
				ModelPolicyDigest: turn.ModelPolicyDigest, ToolPolicyDigest: turn.ToolPolicyDigest,
			}
			if inspected.Context != nil {
				contextSession.SourceLeafId = inspected.Context.SourceLeafId
				contextSession.SourceContextDigest = inspected.Context.SourceContextDigest
				if inspected.Context.ChildContextDigest != "" {
					childDigest := inspected.Context.ChildContextDigest
					contextSession.ChildContextDigest = &childDigest
				}
			}
			RecordContextSession(store, contextSession)
		}
	}
	defer func() {
		input.ActiveMu.Lock()
		delete(*input.ActiveInstances, operation.Id)
		input.ActiveMu.Unlock()
		if closeErr := session.Close(); closeErr != nil {
			panic(closeErr)
		}
	}()

	compactRequested := false
	for _, message := range operation.Context.Messages {
		if message.Command != nil && *message.Command == "compact" {
			compactRequested = true
			break
		}
	}
	// Graph triggers compaction itself so the bounded instructions below
	// apply. Pi's own threshold/overflow compaction stays enabled as a
	// backstop for a context Graph mis-estimated.
	autoCompact := !compactRequested && shouldCompactContextForEntry(entry, lastContextTokens)
	if compactRequested || autoCompact {
		compactionErr := session.Compact(COMPACTION_INSTRUCTIONS)
		if compactionErr == nil {
			turn.FlushDeltas(true)
			if *turn.GateRefusal != nil {
				panic(*turn.GateRefusal)
			}
			text := "上下文已压缩。"
			if turn.PersistEntries {
				AppendNodeEntry(store, NodeEntryInput{
					TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
					ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "system", Kind: "compaction",
					Text: text,
				})
			}
			if compactRequested && operation.Context.RsiContinuation == nil {
				return OperationResult{Outcome: "completed", Output: map[string]any{"text": text}, Usage: turn.Gate.Total()}
			}
		} else {
			// A summarizer that hits its output cap must not poison the
			// turn: the `compaction_end` event already recorded why, so
			// keep going (or report it for a manual request) instead of
			// failing the operation as an unknown dispatch.
			message := compactionErr.Error()
			if compactRequested && operation.Context.RsiContinuation == nil && IsCompactionNoop(message) {
				return OperationResult{Outcome: "completed", Output: map[string]any{"text": "上下文已是精简状态，无需再次压缩。"}, Usage: turn.Gate.Total()}
			}
			if compactRequested && !IsCompactionNoop(message) {
				return OperationResult{Outcome: "failed", Output: map[string]any{"error": "上下文压缩失败：" + message}, Usage: turn.Gate.Total()}
			}
		}
	}
	briefing := ""
	if operation.Context.Briefing != nil {
		briefing = *operation.Context.Briefing
	} else {
		briefing = "Continue work for " + operation.NodeId
	}
	if turn.PersistEntries {
		AppendNodeEntry(store, NodeEntryInput{
			TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
			ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "user", Kind: "briefing",
			Text: truncateRunes(briefing, 20_000),
		})
	}
	attachments := []AttachmentInput{}
	for _, message := range operation.Context.Messages {
		attachments = append(attachments, message.Attachments...)
	}
	userImages := PromptImagesFromAttachments(attachments)
	// A bound skill is knowledge the model cannot call, and a `disable-model-invocation`
	// skill is not in the system prompt at all: the only way its body reaches a turn is
	// the user selecting it. Only this turn's own messages are read for the token - a
	// briefing keeps an earlier turn as standing context and would re-inject it forever.
	turnTexts := []string{}
	for _, message := range operation.Context.Messages {
		if strings.TrimSpace(message.Text) != "" {
			turnTexts = append(turnTexts, message.Text)
		}
	}
	turnText := strings.Join(turnTexts, "\n")
	skillSource := turnText
	if skillSource == "" {
		skillSource = briefing
	}
	skillInjection := InjectRequestedSkills(briefing, piAdapterBoundSkills(turn.ContextAssembly.Bundle.Facts, options.Catalog), RequestedSkillNames(skillSource))
	if len(skillInjection.Injected) > 0 || len(skillInjection.Rejected) > 0 {
		func() {
			defer func() { _ = recover() }()
			store.Event(operation.TaskId, "skill.invoked", map[string]any{
				"operationId": operation.Id, "nodeId": operation.NodeId,
				"injected": skillInjection.Injected, "rejected": skillInjection.Rejected,
			})
		}()
	}
	result, err := session.Prompt(skillInjection.Text, userImages)
	if err != nil {
		panic(err)
	}
	// A recovery records the admission and stops. The real session sends the
	// prompt; this adapter must not settle an empty answer of its own.
	if result.StopReason != nil && *result.StopReason == "admitted" {
		return OperationResult{Outcome: "admitted", Usage: turn.Gate.Total()}
	}
	turn.FlushDeltas(true)
	if *turn.GateRefusal != nil {
		panic(*turn.GateRefusal)
	}
	// A provider or transport error ends the turn with an assistant
	// error message; that is a failure, never a successful operation.
	if result.StopReason != nil && *result.StopReason == "error" {
		message := "Model request failed"
		if result.ErrorMessage != nil {
			message = *result.ErrorMessage
		}
		return OperationResult{Outcome: "failed", Output: map[string]any{"error": message}, Usage: turn.Gate.Total()}
	}
	if result.StopReason != nil && *result.StopReason == "aborted" {
		Raise("interrupted", "用户打断了当前模型思考或工具调用")
	}
	if result.StopReason != nil && *result.StopReason == "length" {
		return OperationResult{
			Outcome: "failed",
			Output:  map[string]any{"error": "Model response hit the output token limit before completing the reply"},
			Usage:   turn.Gate.Total(),
		}
	}
	// An explicit question from the agent ends the turn: the answer is the next
	// turn's input, so waiting costs no further model requests.
	if turn.AskedQuestion != nil {
		question := *turn.AskedQuestion
		return OperationResult{
			Outcome:  "waiting",
			Output:   map[string]any{"question": question},
			Question: &OperationQuestion{Prompt: question.Prompt, Data: map[string]any{"requestType": "user_decision", "prompt": question.Prompt, "why": question.Why, "options": question.Options, "multiple": question.Multiple}},
			Usage:    turn.Gate.Total(),
		}
	}
	if turn.PermissionRequest != nil {
		request := *turn.PermissionRequest
		return OperationResult{
			Outcome: "waiting",
			Output: map[string]any{"permission": map[string]any{
				"grant": request.Grant, "capabilityId": request.CapabilityId, "tool": request.Tool,
			}},
			Question: &OperationQuestion{
				Prompt: "Remote MCP tool " + request.Tool + " requires the user grant " + request.Grant + " in this task",
				Grant:  stringPointer(request.Grant),
			},
			Usage: turn.Gate.Total(),
		}
	}
	text := result.FinalAssistantText
	reply := text
	if strings.TrimSpace(reply) == "" {
		pieces := []string{}
		for _, key := range turn.PartsOrder {
			pieces = append(pieces, turn.Parts[key].text)
		}
		reply = strings.Join(pieces, "")
	}
	turn.FlushDeltas(true)
	if turn.Conversation != nil && IsLeakedCompactionReply(reply) {
		repeated := IsSummaryLeakRetry(operation.Context.PreviousOutput)
		store.Event(operation.TaskId, "session.summary_leaked_as_reply", map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId, "repeated": repeated, "chars": len([]rune(reply)),
		})
		outcome := "continue"
		message := "模型将内部会话摘要作为普通回复，正在自动续行。"
		if repeated {
			outcome = "failed"
			message = "模型连续两轮将内部会话摘要作为普通回复，已停止自动重试。"
		}
		return OperationResult{
			Outcome: outcome,
			Output:  map[string]any{"retryCode": "session_summary_leak", "error": message},
			Usage:   turn.Gate.Total(),
		}
	}
	if turn.PersistEntries && !*turn.SawAssistantMessageEnd && strings.TrimSpace(reply) != "" {
		AppendNodeEntry(store, NodeEntryInput{
			TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
			ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "assistant", Kind: "message", Text: reply,
		})
	}
	return piAdapterTurnOutcome(options, input, turn, entry, reply, store, operation, instanceId)
}

// piAdapterAssistantText is the text of an assistant message, whatever shape its content has.
//
// Since 0.86 a system or user message carries plain string content
// (types.d.ts: content: string | TextContent[]), so the role has to be
// checked before the array shape is assumed.
