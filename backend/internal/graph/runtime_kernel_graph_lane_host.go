package graph

import (
	"errors"
	"fmt"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// host opens the resident process of one node and keeps it for the life
// of the graph's turns.
func (state *kernelGraphLaneState) host(graphId, nodeId string, config any, revisionVersion int) ExecutorHost {
	key := graphId + "/" + nodeId
	cached, hasCached := state.hosts[key]
	signature := CanonicalJSON(config)
	if hasCached && state.hostConfigs[key] == signature {
		return cached
	}
	if hasCached {
		_ = cached.Stop()
	}
	session, hasSession := state.sessions[key]
	if !hasSession {
		panic(errorString("Resident host has no prepared session"))
	}
	if state.closing {
		panic(errorString("Graph runtime is state.closing"))
	}
	if session.Operation == nil {
		panic(errorString("Resident node has no resolved capability operation"))
	}
	workerConfig, ok := config.(PiWorkerConfig)
	if !ok {
		panic(errorString("Resident host has no prepared model connection"))
	}
	model, hasModel := state.boundModels[key]
	if !hasModel {
		panic(errorString("Resident host has no prepared model connection"))
	}
	if prepared, ok := workerConfig.Model.(piModelView); !ok || prepared.Name != model.Id {
		panic(errorString("Resident host has no prepared model connection"))
	}
	purpose := "completion"
	nativeGate := KernelToolGate(state.options.Kernel, graphId, nodeId, "tool", func() bool { return state.closing })
	nativeCalls := map[string]string{}
	// The node's usage is the usage the daemon accounted for: the
	// provider receipts of this execution. The kernel's own report has
	// no evidence grade, so it never releases a reservation.
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
	// The node's admission identity carries the attempt, so a retry is
	// a new admission and an interrupted turn keeps the one it had.
	nodeInput := func() string {
		row := state.options.Kernel.Execution(workerConfig.ExecutionId)
		if row == nil {
			return ""
		}
		suffix := ""
		if row.ResubmitsUsed > 0 {
			suffix = fmt.Sprintf(":resubmit:%d", row.ResubmitsUsed)
		}
		return fmt.Sprintf("%s:attempt:%d%s", row.Id, row.Attempt, suffix)
	}
	// The node's model channel: the controlled provider stream with the
	// node's own gate in front of it. The daemon admits every send,
	// spends the credential and records the usage; the kernel never
	// opens a provider channel of its own.
	nodeChannel := func(raw any, hostSignal *AbortSignal, streamOptions WorkerModelOptions) (*kernelGraphLaneNodeChannel, error) {
		credential := state.options.CredentialFor(model)
		if credential == nil {
			panic(errorString("Bound model credential unavailable"))
		}
		context, _ := raw.(map[string]any)
		if context == nil {
			panic(errorString("Invalid model context"))
		}
		if _, ok := context["messages"].([]any); !ok {
			panic(errorString("Invalid model context"))
		}
		channel := &kernelGraphLaneNodeChannel{}
		gate := KernelProviderGate(state.options.Kernel, graphId, nodeId, nil, &model, &ProviderRecipe{
			Definition: session.Binding.DefinitionVersion, Review: session.Role == "reviewer",
		}, purpose)
		observed := SendGate{
			Dispatch: func(id string, reservation float64, send func() any) any {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					if failure, ok := recovered.(*RuntimeError); ok && (failure.Code == "paused" || failure.Code == "budget") {
						channel.refusal = failure
					}
					panic(recovered)
				}()
				return gate.Dispatch(id, reservation, send)
			},
			Settle: func(id string, cost *TokenUsage) {
				gate.Settle(id, cost)
				if cost == nil {
					channel.unknown = true
					return
				}
				channel.usage.Input += cost.Input
				channel.usage.Output += cost.Output
				channel.usage.CacheRead += cost.CacheRead
				channel.usage.CacheWrite += cost.CacheWrite
			},
		}
		execution := state.options.Kernel.RunningExecution(graphId, nodeId)
		if execution == nil {
			panic(errorString("No active execution"))
		}
		executionID := execution.Id
		abort := NewAbortSignal()
		cancel := func() { abort.Abort() }
		releases := []func(){}
		if hostSignal != nil {
			abortListener := hostSignal.AddEventListener("abort", cancel, true)
			releases = append(releases, func() { hostSignal.RemoveEventListener(abortListener) })
		}
		unsubscribe := state.options.Kernel.Store.OnEvent(func(string) {
			if state.options.Kernel.Store.Task(graphId).Phase == "stopping" {
				abort.Abort()
			}
		})
		releases = append(releases, unsubscribe)
		channel.release = func() {
			for _, release := range releases {
				release()
			}
		}
		slot := kernelGraphLaneSlot(state.options, model, credential, executionID)
		stream, err := ControlledOpenAIStream(observed, model, func(candidate ModelEntry) string {
			binding := state.options.CredentialFor(candidate)
			if binding == nil {
				panic(errorString("Bound model credential unavailable"))
			}
			return binding.ApiKey
		}, slot, model.Api, PiAdapterStreamOptions{
			EstimateMissing: kernelGraphLaneUnlimited(state.options.Kernel, executionID),
			OnRequest: func(callId string, profile map[string]any) {
				// The TypeScript event spreads the profile into the event object,
				// so the profile's own keys sit beside callId and model.
				event := map[string]any{
					"callId": callId, "executionId": executionID, "nodeId": nodeId, "model": model.Id,
					"rates": model.Cost, "pricing": model.Pricing,
				}
				for name, value := range profile {
					event[name] = value
				}
				state.options.Kernel.Store.Event(graphId, "provider.request_profile", event)
			},
			OnSend: func(sent PiAdapterSentRequest) {
				tools := "[]"
				if sent.ToolDeclarations != nil {
					tools = kernelGraphLaneJSON(sent.ToolDeclarations)
				}
				kernelExec(state.options.Kernel.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
					graphId, nodeId, executionID, rsiStringValue(sent.SystemPrompt), tools, NowMillis())
			},
		})(ToPiModel(model), context, kernelGraphLaneStreamOptions(streamOptions, abort))
		if err != nil {
			channel.release()
			return nil, err
		}
		channel.inner = stream
		return channel, nil
	}
	residentOptions := kernelGraphLaneNodeChannels{
		OnTelemetry: func(call PiAdapterToolCall) {
			defer func() { _ = recover() }()
			state.options.Kernel.Store.RecordToolCall(ToolCallInput{InstanceID: session.Binding.InstanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: call.Target})
		},
		// The node's `submit` runs in the host, over the real execution (HB-262): the lane
		// wires that through `onToolCall` when it builds the runner.
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
						Role: "system", Kind: "compaction", Text: summary,
					})
					tokensBefore := (*int64)(nil)
					if value, ok := result["tokensBefore"].(float64); ok {
						converted := int64(value)
						tokensBefore = &converted
					}
					state.options.Kernel.Store.Event(graphId, "session.compacted", map[string]any{"nodeId": nodeId, "operationId": executionID, "tokensBefore": tokensBefore})
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
				kernelExec(state.options.Kernel.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
					graphId, nodeId, rsiStringValue(executionID), rsiText(data["systemPrompt"]), tools, NowMillis())
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
				// The TypeScript test is `'isError' in result && result.isError`, so a
				// present but false flag is not a failure.
				if value, isError := record["isError"]; isError && kernelGraphLaneTruthy(value) {
					failed = true
				}
			}
			return PiToolAnswer{Ok: !failed, Text: kernelGraphLaneJSON(result)}, nil
		},
	}
	{
		// The node's own tools: the Graph's, the native ones the daemon
		// provides in Go, and the `submit` the host executes against the
		// real execution.
		nodeTools := []ToolDefinition{}
		nativeTools := []string{}
		readRoots := []string{}
		writeRoots := []string{}
		mcpServers := []McpAdapterServerRef{}
		allowedToolNames := []string{"submit"}
		if session.Operation != nil {
			nodeTools = append(nodeTools, session.Operation.Tools...)
			nativeTools = append(nativeTools, session.Operation.NativeTools...)
			readRoots = append(readRoots, session.Operation.ReadRoots...)
			writeRoots = append(writeRoots, session.Operation.WriteRoots...)
			mcpServers = append(mcpServers, session.Operation.McpAdapterServers...)
		}
		for _, name := range session.AllowedToolNames {
			if name != "submit" {
				allowedToolNames = append(allowedToolNames, name)
			}
		}
		submit := kernelGraphLaneSubmitTool()
		nodeTools = append(nodeTools, ToolDefinition{
			Name:        submit.Name,
			Label:       submit.Label,
			Description: submit.Description,
			Parameters:  asMap(submit.Parameters),
			// The `submit` runs in the host, over the real execution
			// (HB-262): the lane wires that through `onToolCall`.
			Execute: func(_ string, params any) (any, error) {
				answer, _ := residentOptions.OnToolCall("submit", params)
				if !answer.Ok {
					return nil, errors.New(answer.Text)
				}
				return agentToolsText(answer.Text), nil
			},
		})
		// The codemode tool reaches the node's own tools from a
		// script. Its host table is the tool list as it stands now,
		// so a script cannot start another script.
		if state.options.Codemode.Enabled {
			nodeTools = append(nodeTools, CodemodeTool(nodeTools, nativeGate,
				codemodeSettings(state.options.Codemode, state.options.StateDir)))
		}
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
			// The skills the node may load: its own folder, the bound
			// snapshots and the native folders. The kernel has no
			// environment of its own, so the daemon puts them in the
			// prompt.
			SkillPaths:  append([]string{}, workerConfig.SkillPaths...),
			SkillFolder: stringPointerValue(workerConfig.SkillFolder),
			// The Pi extensions the node would load. The kernel state.hosts
			// them in a process of their own, so a node may only bind
			// one when its own policy is as wide as the daemon's reach.
			PiExtensionPaths:        append([]string{}, workerConfig.PiExtensionPaths...),
			PiExtensionTools:        append([]string{}, workerConfig.PiExtensionTools...),
			ExtensionProcessAllowed: pigExtensionProcessAllowed(nodeAccessPolicy(session)),
			ReadRoots:               readRoots,
			WriteRoots:              writeRoots,
			SystemPrompt:            session.SystemPrompt,
			AllowedToolNames:        allowedToolNames,
			BundleDigest:            session.BundleDigest,
			ToolPolicyDigest:        session.ToolPolicyDigest,
			RuntimePolicyDigest:     session.RuntimePolicyDigest,
			McpAdapterServers:       mcpServers,
		}
		host := NewPigNodeHost(PigNodeHostOptions{
			Database: state.options.Kernel.Store.Path,
			Request:  nodeRequest,
			Gate:     nativeGate,
			// The `submit` is the host's own tool: the host executes it
			// against the real execution, so the node's tool gate does
			// not stand in front of it.
			Ungated: []string{"submit"},
			// The kernel asks the daemon for the answer; the daemon's own
			// controlled stream produces it.
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
		state.hosts[key] = host
		state.hostConfigs[key] = signature
		return host
	}
}
