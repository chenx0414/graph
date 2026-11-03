package graph

// graphManagement binds the graph control surface to one owner task. The
// TypeScript supervisor spread graphManagement() into itself, so the graph
// tools of the main Agent read the same surface.
func (runtime *TaskRuntime) graphManagement(taskId string, agent ...bool) AgentToolsGraphManagement {
	service := runtime.graphService(taskId)
	return AgentToolsGraphManagement{
		GraphCreate: func(input map[string]any) any {
			request := GraphCreateInput{Definition: input["definition"]}
			if branch, ok := input["targetBranch"].(string); ok && branch != "" {
				request.TargetBranch = &branch
			}
			if requestID, ok := input["requestId"].(string); ok && requestID != "" {
				request.RequestId = &requestID
			}
			return service.GraphCreate(request)
		},
		GraphPatch: func(input map[string]any) any {
			baseRevision, _ := agentToolsNumber(input["baseRevision"])
			return service.GraphPatch(GraphPatchInput{
				GraphId:      agentToolsString(input["graphId"]),
				BaseRevision: int(baseRevision),
				Changes:      graphManagementPatchChange(input["changes"]),
			})
		},
		GraphInspect: func(input map[string]any) any {
			request := GraphInspectInput{GraphId: agentToolsString(input["graphId"])}
			if query, ok := input["query"].(string); ok {
				request.Query = &query
			}
			if id, ok := input["id"].(string); ok {
				request.Id = &id
			}
			if delivery, ok := input["deliveryId"].(string); ok {
				request.DeliveryId = &delivery
			}
			if transition, ok := input["transitionId"].(string); ok {
				request.TransitionId = &transition
			}
			if after, ok := agentToolsNumber(input["after"]); ok {
				value := int(after)
				request.After = &value
			}
			if limit, ok := agentToolsNumber(input["limit"]); ok {
				value := int(limit)
				request.Limit = &value
			}
			return service.GraphInspect(request)
		},
		GraphControl: func(input map[string]any) any {
			request := GraphControlInput{
				GraphId: agentToolsString(input["graphId"]),
				Action:  agentToolsString(input["action"]),
			}
			request.Proof, _ = input["proof"].(string)
			// A retried control action names its request so the kernel can recognise
			// the replay instead of doing the same thing twice.
			request.RequestID, _ = input["requestId"].(string)
			if len(agent) > 0 && agent[0] {
				request.AgentTaskID = taskId
				request.SourceMessageID, _ = input["sourceMessageId"].(string)
				request.Instruction, _ = input["instruction"].(string)
			}
			if nodeID, ok := input["nodeId"].(string); ok {
				request.NodeId = &nodeID
			}
			if moduleID, ok := input["moduleId"].(string); ok {
				request.ModuleId = &moduleID
			}
			if seq, ok := agentToolsNumber(input["seq"]); ok {
				value := int(seq)
				request.Seq = &value
			}
			if operationID, ok := input["operationId"].(string); ok {
				request.OperationId = &operationID
			}
			if callID, ok := input["callId"].(string); ok {
				request.CallId = &callID
			}
			// What complete_with_limitations closes on. The actor is not read from
			// the payload: this door speaks as the Agent, so the service refuses a
			// human acceptance item here whatever the arguments claim.
			request.Limitations = graphAcceptanceLimitationsOfPayload(input)
			if usage, ok := input["usage"].(map[string]any); ok {
				parsed := &TokenUsage{}
				if value, ok := agentToolsNumber(usage["input"]); ok {
					parsed.Input = int64(value)
				}
				if value, ok := agentToolsNumber(usage["output"]); ok {
					parsed.Output = int64(value)
				}
				if value, ok := agentToolsNumber(usage["cacheRead"]); ok {
					parsed.CacheRead = int64(value)
				}
				if value, ok := agentToolsNumber(usage["cacheWrite"]); ok {
					parsed.CacheWrite = int64(value)
				}
				request.Usage = parsed
			}
			return service.GraphControl(request)
		},
		GraphSend: func(input map[string]any) any {
			request := GraphSendInput{GraphId: agentToolsString(input["graphId"])}
			if nodeID, ok := input["nodeId"].(string); ok {
				request.NodeId = &nodeID
			}
			if name, ok := input["input"].(string); ok {
				request.Input = &name
			}
			if value, ok := input["value"]; ok {
				request.Value = value
			}
			if text, ok := input["text"].(string); ok {
				request.Text = &text
			}
			return service.GraphSend(request)
		},
		HarnessCompare: func(input map[string]any) any {
			nodeIds := []string{}
			switch typed := input["nodeIds"].(type) {
			case []string:
				nodeIds = append(nodeIds, typed...)
			case []any:
				for _, item := range typed {
					nodeIds = append(nodeIds, agentToolsString(item))
				}
			}
			baseline, _ := input["baselineNodeId"].(string)
			domain, _ := input["domain"].(string)
			comparison := service.HarnessCompare(HarnessCompareInput{
				GraphId:        agentToolsString(input["graphId"]),
				NodeIds:        nodeIds,
				BaselineNodeId: baseline,
				Domain:         domain,
			})
			return comparison
		},
		HarnessExperience: func(input map[string]any) any {
			domain, _ := input["domain"].(string)
			// A scope names the one store to read. The recording path needs it:
			// it appends to that store, and a read that answered with another
			// scope would make it write over what is already there.
			scope, _ := input["scope"].(string)
			return service.HarnessExperience(HarnessExperienceInput{Domain: domain, Scope: scope})
		},
		HarnessProbe:    service.HarnessProbe,
		HarnessEvidence: service.HarnessEvidence,
		HarnessFriction: service.HarnessFriction,
		HarnessDecision: service.HarnessDecision,
	}
}

// graphService binds the management surface to one owner task. The Agent tools
// and the user-only doors share it: they differ in who they say is acting, not in
// what a graph control does.
func (runtime *TaskRuntime) graphService(taskId string) GraphManagement {
	return NewGraphManagement(runtime.kernel, taskId, func(graphId string, branch string) {
		if runtime.git != nil {
			runtime.git.PrepareTask(graphId, branch)
		}
	}, runtime.artifacts)
}

// graphManagementPatchChange reads the changes object of a graph patch.
func graphManagementPatchChange(raw any) PatchChange {
	change := PatchChange{}
	record, ok := raw.(map[string]any)
	if !ok {
		return change
	}
	change.Reason = agentToolsString(record["reason"])
	if definition, ok := record["definition"]; ok && definition != nil {
		parsed := ParseGraphDefinition(definition)
		change.Definition = &parsed
	}
	if patch, ok := record["patch"]; ok && patch != nil {
		change.Patch = patch
		change.HasPatch = true
	}
	if retire, ok := record["retire"].([]any); ok {
		for _, item := range retire {
			if text, ok := item.(string); ok {
				change.Retire = append(change.Retire, text)
			}
		}
	}
	return change
}
