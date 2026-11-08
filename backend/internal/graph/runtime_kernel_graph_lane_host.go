package graph

import (
	"fmt"

	"errors"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func (state *kernelGraphLaneState) host(graphId, nodeId string, config any, revisionVersion int) ExecutorHost {
	key := graphId + "/" + nodeId
	cached, hasCached := state.hosts.Lookup(key)
	signature := CanonicalJSON(config)
	if hasCached && state.hostConfigs.Get(key) == signature {
		return cached
	}
	if hasCached {
		_ = cached.Stop()
	}
	session, hasSession := state.sessions.Lookup(key)
	if !hasSession {
		panic(errorString("Resident host has no prepared session"))
	}
	if state.closing.Load() {
		panic(errorString("Graph runtime is closing"))
	}
	if session.Operation == nil {
		panic(errorString("Resident node has no resolved capability operation"))
	}
	workerConfig, ok := config.(PiWorkerConfig)
	if !ok {
		panic(errorString("Resident host has no prepared model connection"))
	}
	model, hasModel := state.boundModels.Lookup(key)
	if !hasModel {
		panic(errorString("Resident host has no prepared model connection"))
	}
	if prepared, ok := workerConfig.Model.(piModelView); !ok || prepared.Name != model.Id {
		panic(errorString("Resident host has no prepared model connection"))
	}
	purpose := "completion"
	nativeGate := KernelToolGate(state.options.Kernel, graphId, nodeId, "tool", func() bool { return state.closing.Load() })
	nativeCalls := map[string]string{}
	nodeUsage := func() *PiTurnUsage {
		calls := state.options.Kernel.ProviderCalls(graphId, nodeId)
		usage := PiTurnUsage{}
		count := 0
		for _, call := range calls {
			if call.ExecutionId != workerConfig.ExecutionId {
				continue
			}
			count++
			if call.Usage == nil || (call.State != "settled" && call.State != "reconciled") {
				return nil
			}
			usage.Input += call.Usage.Input
			usage.Output += call.Usage.Output
			usage.CacheRead += call.Usage.CacheRead
			usage.CacheWrite += call.Usage.CacheWrite
			usage.Total += call.Usage.Input + call.Usage.Output + call.Usage.CacheRead + call.Usage.CacheWrite
		}
		if count == 0 {
			return nil
		}
		accounted := true
		usage.Accounted = &accounted
		return &usage
	}
	nodeInput := func() string {
		row := state.options.Kernel.Execution(workerConfig.ExecutionId)
		if row == nil {
			return ""
		}
		suffix := ""
		if row.ResubmitsUsed > 0 {
			suffix = fmt.Sprintf(":resubmit:%d", row.ResubmitsUsed)
		}
		if answer := kernelRow(state.options.Kernel.Db, "SELECT question_id FROM node_questions WHERE execution_id=? AND state='answered' ORDER BY rowid DESC LIMIT 1", row.Id); answer != nil {
			suffix += ":question:" + kernelString(answer["question_id"])
		}
		return fmt.Sprintf("%s:attempt:%d%s", row.Id, row.Attempt, suffix)
	}
	nodeChannel := func(raw any, hostSignal *AbortSignal, streamOptions WorkerModelOptions) (*kernelGraphLaneNodeChannel, error) {
		return state.modelChannel(graphId, nodeId, session, model, purpose, raw, hostSignal, streamOptions)
	}
	residentOptions := kernelGraphLaneNodeChannels{
		OnTelemetry: func(call PiAdapterToolCall) {
			defer func() { _ = recover() }()
			state.options.Kernel.Store.RecordToolCall(ToolCallInput{InstanceID: session.Binding.InstanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: call.Target})
		},
		OnEvent: func(event any) {
			data, _ := event.(map[string]any)
			if data == nil {
				return
			}
			execution := state.options.Kernel.RunningExecution(graphId, nodeId)
			executionID := (*string)(nil)
			if execution != nil {
				value := execution.Id
				executionID = &value
			}
			switch rsiText(data["type"]) {
			case "compaction_start":
				purpose = "compaction"
				state.options.Kernel.Store.Event(graphId, "session.compaction_started", map[string]any{"nodeId": nodeId, "operationId": executionID})
			case "compaction_end":
				purpose = "completion"
				result, _ := data["result"].(map[string]any)
				aborted, _ := data["aborted"].(bool)
				if !aborted && result != nil {
					summary := rsiText(result["summary"])
					AppendNodeEntry(state.options.Kernel.Store, NodeEntryInput{
						TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
						Role: "system", Kind: "compaction", Text: summary + "\n" + compactionPointer(graphId),
					})
					tokensBefore := (*int64)(nil)
					if value, ok := result["tokensBefore"].(float64); ok {
						converted := int64(value)
						tokensBefore = &converted
					}
					state.options.Kernel.Store.Event(graphId, "session.compacted", map[string]any{"nodeId": nodeId, "operationId": executionID, "tokensBefore": tokensBefore, "summary": summary})
				} else {
					message := "compaction aborted"
					if text := rsiText(data["errorMessage"]); text != "" {
						message = text
					}
					state.options.Kernel.Store.Event(graphId, "session.compaction_failed", map[string]any{"nodeId": nodeId, "operationId": executionID, "error": message})
				}
			case "graph_provider_prompt":
				tools := "[]"
				if text, ok := data["tools"].(string); ok {
					tools = text
				} else if data["tools"] != nil {
					tools = kernelGraphLaneJSON(data["tools"])
				}
				state.options.Kernel.RecordPrompt(graphId, nodeId, rsiStringValue(executionID), rsiText(data["systemPrompt"]), tools)
			case "message_end":
				message, _ := data["message"].(map[string]any)
				if message == nil || rsiText(message["role"]) != "assistant" {
					break
				}
				text := kernelGraphLaneMessageText(message["content"])
				if text != "" {
					AppendNodeEntry(state.options.Kernel.Store, NodeEntryInput{
						TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
						Role: "assistant", Kind: "message", Text: text,
					})
				}
			case "tool_execution_start", "tool_execution_end":
				call := rsiText(data["type"]) == "tool_execution_start"
				reason := ""
				if !call {
					if failed, ok := data["isError"].(bool); ok && failed {
						reason = ToolResultText(data["result"], 0)
					}
				}
				text := ""
				if reason != "" {
					runes := []rune(reason)
					if len(runes) > 400 {
						runes = runes[:400]
					}
					text = "工具执行失败：" + string(runes)
				} else if call {
					text = kernelGraphLaneJSON(kernelGraphLaneToolCall{Name: rsiText(data["toolName"]), Args: data["args"]})
				} else {
					text = kernelGraphLaneJSON(data["result"])
				}
				entryData := map[string]any{
					"toolName": rsiText(data["toolName"]), "toolCallId": rsiText(data["toolCallId"]), "isError": data["isError"],
				}
				if reason != "" {
					entryData["message"] = reason
				}
				AppendNodeEntry(state.options.Kernel.Store, NodeEntryInput{
					TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
					Role: "tool", Kind: map[bool]string{true: "call", false: "result"}[call], Text: text, Data: entryData,
				})
			}
		},
		OnToolCall: func(name string, args any) (PiToolAnswer, error) {
			if name == "submit" {
				ok, text := SubmitNodeCall(state.options.Kernel, workerConfig.ExecutionId, args)
				return PiToolAnswer{Ok: ok, Text: text}, nil
			}
			if name == "native_tool_start" || name == "native_tool_settle" {
				call, _ := args.(map[string]any)
				if call == nil {
					return PiToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
				}
				callID := rsiText(call["id"])
				if callID == "" {
					return PiToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
				}
				toolName := rsiText(call["name"])
				admitted := false
				for _, candidate := range append(append([]string{}, session.Operation.NativeTools...), session.Operation.PiExtensionTools...) {
					if candidate == toolName {
						admitted = true
						break
					}
				}
				if !admitted {
					return PiToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
				}
				if name == "native_tool_start" {
					if _, ok := nativeCalls[callID]; ok {
						return PiToolAnswer{Ok: false, Text: "Native tool already admitted"}, nil
					}
					id := graphUUID()
					nativeGate.Dispatch(id, 0, func() any { return nil })
					nativeCalls[callID] = id
				} else {
					id, ok := nativeCalls[callID]
					if !ok {
						return PiToolAnswer{Ok: false, Text: "Native tool has no admission"}, nil
					}
					nativeGate.Settle(id, &TokenUsage{})
					delete(nativeCalls, callID)
				}
				return PiToolAnswer{Ok: true, Text: "ok"}, nil
			}
			var tool *ToolDefinition
			if session.Operation != nil {
				for index, candidate := range session.Operation.Tools {
					if candidate.Name == name {
						tool = &session.Operation.Tools[index]
						break
					}
				}
			}
			if tool == nil {
				if state.options.OnToolCall != nil {
					return state.options.OnToolCall(graphId, nodeId, name, args), nil
				}
				return PiToolAnswer{Ok: false, Text: "the host does not offer a tool named " + name}, nil
			}
			id := graphUUID()
			result := nativeGate.Dispatch(id, 0, func() any {
				defer nativeGate.Settle(id, &TokenUsage{})
				if tool.Execute == nil {
					return nil
				}
				value, executeErr := tool.Execute(id, args)
				if executeErr != nil {
					return executeErr
				}
				return value
			})
			if failure, ok := result.(error); ok {
				return PiToolAnswer{Ok: false, Text: failure.Error()}, nil
			}
			failed := false
			if record, ok := result.(map[string]any); ok {
				if value, isError := record["isError"]; isError && kernelGraphLaneTruthy(value) {
					failed = true
				}
			}
			return PiToolAnswer{Ok: !failed, Text: kernelGraphLaneJSON(result)}, nil
		},
	}
	{
		nodeTools := []ToolDefinition{}
		nativeTools := []string{}
		readRoots := []string{}
		writeRoots := []string{}
		allowedToolNames := []string{"submit"}
		if session.Operation != nil {
			nodeTools = append(nodeTools, session.Operation.Tools...)
			nativeTools = append(nativeTools, session.Operation.NativeTools...)
			readRoots = append(readRoots, session.Operation.ReadRoots...)
			writeRoots = append(writeRoots, session.Operation.WriteRoots...)
		}
		for _, name := range session.AllowedToolNames {
			if name != "submit" {
				allowedToolNames = append(allowedToolNames, name)
			}
		}
		bundleDigest := session.BundleDigest
		toolPolicyDigest := session.ToolPolicyDigest
		runtimePolicyDigest := session.RuntimePolicyDigest
		if frozen := state.restoring.Get(graphId + "/" + nodeId); frozen != nil {
			allowedToolNames = append([]string{}, frozen.Record.Policy.AllowedToolNames...)
			bundleDigest = frozen.Record.Policy.BundleDigest
			toolPolicyDigest = frozen.Record.Policy.ToolPolicyDigest
			runtimePolicyDigest = frozen.Record.Policy.RuntimePolicyDigest
		}
		submit := kernelGraphLaneSubmitTool()
		nodeTools = append(nodeTools, ToolDefinition{
			Name:        submit.Name,
			Label:       submit.Label,
			Description: submit.Description,
			Parameters:  asMap(submit.Parameters),
			Execute: func(_ string, params any) (any, error) {
				answer, _ := residentOptions.OnToolCall("submit", params)
				if !answer.Ok {
					return nil, errors.New(answer.Text)
				}
				return agentToolsText(answer.Text), nil
			},
		})
		nodeRequest := AgentSessionRequest{
			ExecutionId:            workerConfig.ExecutionId,
			ExecutionConfiguration: workerConfig.NodeExecutionConfiguration,
			CapabilityDescriptor:   workerConfig.CapabilityDescriptor,
			CredentialReference:    workerConfig.CredentialReference,
			Binding: AgentSessionBinding{
				InstanceId: session.Binding.InstanceId, NodeId: session.Binding.NodeId,
				DefinitionVersion: session.Binding.DefinitionVersion,
			},
			Workspace:   workerConfig.Workspace,
			StateDir:    workerConfig.StateDir,
			Model:       workerConfig.Model,
			Tools:       nodeTools,
			NativeTools: nativeTools,
			OnToolCall: func(call PiAdapterToolCall) {
				defer func() { _ = recover() }()
				target := any(nil)
				if call.Target != nil {
					target = call.Target
				}
				state.options.Kernel.Store.RecordToolCall(ToolCallInput{
					InstanceID: session.Binding.InstanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: target,
				})
			},
			SkillPaths:  append([]string{}, workerConfig.SkillPaths...),
			SkillFolder: stringPointerValue(workerConfig.SkillFolder),
			PiExtensionPaths:        append([]string{}, workerConfig.PiExtensionPaths...),
			PiExtensionTools:        append([]string{}, workerConfig.PiExtensionTools...),
			ExtensionProcessAllowed: true,
			ReadRoots:               readRoots,
			WriteRoots:              writeRoots,
			SystemPrompt:            session.SystemPrompt,
			AllowedToolNames:        allowedToolNames,
			BundleDigest:            bundleDigest,
			ToolPolicyDigest:        toolPolicyDigest,
			RuntimePolicyDigest:     runtimePolicyDigest,
		}
		host := NewPigNodeHost(PigNodeHostOptions{
			Database: state.options.Kernel.Store.Path,
			Store:    state.options.Kernel.Store,
			Request:  nodeRequest,
			Gate:     nativeGate,
			Codemode: codemodeSettings(state.options.Codemode, state.options.StateDir),
			Ungated: []string{"submit"},
			Stream: func(_ any, context map[string]any, _ map[string]any) (ModelEventStream, error) {
				channel, err := nodeChannel(context, nil, WorkerModelOptions{})
				if err != nil {
					return nil, err
				}
				return channel, nil
			},
			RequestId: nodeInput,
			Usage:     nodeUsage,
			PreAdmission: func() []string {
				ids := []string{}
				for _, call := range state.options.Kernel.ProviderCalls(graphId, nodeId) {
					ids = append(ids, call.Id)
				}
				return ids
			},
			OnEvent: func(event map[string]any) {
				residentOptions.OnEvent(event)
			},
			OnToolCall: func(call pigkernel.ToolCallRecord) {
				residentOptions.OnTelemetry(PiAdapterToolCall{Tool: call.Name, IsError: call.IsError})
			},
			OnReady: func(sessionId string, sessionFile string) {
				RecordNodeSession(state.options.Kernel.Store, session.Binding.InstanceId, sessionId, sessionFile)
			},
			RecoveredAttempt: func() int {
				return pigNodeRecoveredAttempt(state.options.Kernel, session.Binding.InstanceId, workerConfig.ExecutionId)
			},
		})
		state.hosts.Store(key, host)
		state.hostConfigs.Store(key, signature)
		return host
	}
}
