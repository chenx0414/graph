package graph

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

func piAdapterRunTurn(options PiAdapterOptions, transport AgentSessionTransport, input piAdapterRunInput, turn piAdapterTurnInput) OperationResult {
	operation := input.Operation
	entry := input.Entry
	store := options.Store
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
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
				EstimateMissing: true,
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
					ReportPromptIntegrity(filepath.Join(options.InstancesDir, instanceId), operation.Id, sent.SystemPrompt, nil)
				},
				OnTransport: func(observation ProviderTransportObservation) {
					data := observation.Fields()
					data["operationId"] = operation.Id
					data["instanceId"] = instanceId
					data["model"] = entry.Id
					store.Event(operation.TaskId, "provider.transport", data)
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
		McpServers:              append([]McpServerRef{}, turn.CapabilityOperation.McpServers...),
		PiExtensionTools:        append([]string{}, turn.CapabilityOperation.PiExtensionTools...),
		SystemPrompt:            turn.ComposedPrompt,
		BundleDigest:            turn.CapabilityOperation.BundleDigest,
		LegacyCapabilityDigest:  stringPointer(turn.CapabilityOperation.LegacyPromptDigest),
		ToolPolicyDigest:        turn.CapabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest:     turn.CapabilityOperation.RuntimePolicyDigest,
		Broker:                  turn.ObservedGate,
		NativeTools:             append([]string{}, turn.CapabilityOperation.NativeTools...),
		AllowWorkspaceChange:    turn.Conversation != nil,
		Compaction:              piAdapterCompactionSettings(entry),
		OnEvent:                 turn.OnEvent,
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
	for _, message := range operation.Context.Messages {
		if message.FreshSession {
			request.FreshSession = true
			request.IsolatedContext = true
			break
		}
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
		if errors.Is(err, errPiExtensionNotHosted) {
			return OperationResult{Outcome: "failed", Output: map[string]any{
				"setupError": piExtensionRefusalText(request.CapabilityDescriptor, request.PiExtensionPaths) + ": " + err.Error(),
			}, Usage: turn.Gate.Total()}
		}
		panic(err)
	}
	input.ActiveMu.Lock()
	(*input.ActiveInstances)[operation.Id] = session
	input.ActiveMu.Unlock()
	unregisterInjector := func() {}
	if target, ok := deferredToolTargetOf(store, operation.Id); ok {
		unregisterInjector = RegisterConversationInjector(target.ConversationId, func(text string) bool {
			return session.Steer(text) == nil
		})
	}
	defer unregisterInjector()
	inspected := session.Inspect()
	raisePiExtensionLoadErrors(inspected.ExtensionErrors)
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
	compacted := false
	if compactRequested {
		compactionErr := session.Compact(COMPACTION_INSTRUCTIONS)
		if compactionErr == nil {
			compacted = true
			options.TaskSetups.Forget(instanceId)
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
			message := compactionErr.Error()
			if compactRequested && operation.Context.RsiContinuation == nil && IsCompactionNoop(message) {
				return OperationResult{Outcome: "completed", Output: map[string]any{}, Usage: turn.Gate.Total()}
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
	setupText := ""
	setupSent := false
	if operation.Context.BriefingSetupLength != nil {
		length := *operation.Context.BriefingSetupLength
		if length > 0 && length <= len(briefing) {
			setupText = briefing[len(briefing)-length:]
		}
	}
	if setupText != "" && taskSetupReuseEnabled() && !compacted &&
		options.TaskSetups.Sent(instanceId, inspected.SessionId, setupText) {
		briefing = taskSetupOmittedPrompt(briefing, len(setupText))
	} else {
		setupSent = setupText != ""
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
	pigExtensionTurnStart(store, operation.TaskId, operation.Id, operation.NodeId, request.Workspace, skillInjection.Text)
	result, err := session.Prompt(skillInjection.Text, userImages)
	if err == nil && setupSent {
		options.TaskSetups.Record(instanceId, inspected.SessionId, setupText)
	}
	if err != nil {
		panic(err)
	}
	if result.StopReason != nil && *result.StopReason == "admitted" {
		return OperationResult{Outcome: "admitted", Usage: turn.Gate.Total()}
	}
	turn.FlushDeltas(true)
	if *turn.GateRefusal != nil {
		panic(*turn.GateRefusal)
	}
	if result.StopReason != nil && *result.StopReason == "error" {
		message := "Model request failed"
		if result.ErrorMessage != nil {
			message = *result.ErrorMessage
		}
		return OperationResult{Outcome: "failed", Output: map[string]any{"error": message}, Usage: turn.Gate.Total()}
	}
	if result.ErrorMessage != nil && strings.TrimSpace(*result.ErrorMessage) != "" {
		return OperationResult{Outcome: "failed", Output: map[string]any{"error": *result.ErrorMessage}, Usage: turn.Gate.Total()}
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
	if turn.AskedQuestion != nil && *turn.AskedQuestion != nil {
		question := **turn.AskedQuestion
		requestType := "user_decision"
		if question.ToSupervisor {
			requestType = "supervisor_decision"
		}
		return OperationResult{
			Outcome:  "waiting",
			Output:   map[string]any{"question": question},
			Question: &OperationQuestion{Prompt: question.Prompt, Data: map[string]any{"requestType": requestType, "prompt": question.Prompt, "why": question.Why, "options": question.Options, "recommended": question.Recommended, "multiple": question.Multiple}},
			Usage:    turn.Gate.Total(),
		}
	}
	if turn.PermissionRequest != nil && *turn.PermissionRequest != nil {
		request := **turn.PermissionRequest
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
