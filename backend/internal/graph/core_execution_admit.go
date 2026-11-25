package graph

import (
	"strings"

	"encoding/json"
)

func (e *Execution) admit(node ExecutionNodeRow, spec NodeSpec, reservation int64, workspace *string, grants []string) (Operation, bool) {
	var handoffPackage *ContextHandoffPackage
	operation, admitted, failure := func() (operation Operation, admitted bool, failure any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				failure = recovered
			}
		}()
		task := e.store.Task(node.TaskId)
		conversation := ConversationForTask(e.store, node.TaskId)
		chatMessages := []MessageRow{}
		if task.Phase == "chatting" && conversation != nil {
			chatMessages = PendingMessages(e.store, conversation.Id, 1)
		}
		var rsiContinuation *RsiContinuation
		var pauseContinuation *PauseContinuation
		var wakes []PendingWake
		if conversation != nil {
			rsiContinuation = PendingRsiContinuation(e.store, node.TaskId, node.Id)
			pauseContinuation = PendingPauseContinuation(e.store, node.TaskId, node.Id)
			wakes = PendingWakes(e.store, node.TaskId, node.Id)
		}
		answers := []OperationAnswer{}
		answerQuestionIDs := []string{}
		for _, row := range e.store.UndeliveredAnswers(node.TaskId, node.Id) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(kernelString(row["answer"])), &payload); err != nil {
				panic(err)
			}
			answers = append(answers, OperationAnswer{QuestionId: kernelString(row["id"]), Value: payload["value"]})
			answerQuestionIDs = append(answerQuestionIDs, kernelString(row["id"]))
		}
		messages := []OperationMessage{}
		if task.Phase == "chatting" {
			for _, message := range chatMessages {
				id := message.Id
				entry := OperationMessage{
					Id:                 &id,
					Text:               message.Text,
					RequirementVersion: int(task.RequirementVersion),
				}
				if message.Data != nil {
					var data map[string]any
					if err := json.Unmarshal([]byte(*message.Data), &data); err == nil {
						if attachments, ok := data["attachments"].([]any); ok {
							for _, raw := range attachments {
								record, ok := jsonRecord(raw)
								if !ok {
									continue
								}
								entry.Attachments = append(entry.Attachments, AttachmentInput{
									Name: stringField(record, "name"),
									Type: stringField(record, "type"),
									Size: int64(numberField(record, "size")),
									Text: stringField(record, "text"),
									Data: optionalStringField(record, "data"),
								})
							}
						}
						if command, ok := data["command"].(string); ok && command != "" {
							entry.Command = &command
						}
						if source, ok := data["source"].(map[string]any); ok {
							if fresh, ok := source["freshSession"].(bool); ok && fresh {
								entry.FreshSession = true
							}
						}
					}
				}
				messages = append(messages, entry)
			}
		} else {
			for _, row := range kernelRows(e.store.Db, "SELECT data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor", node.TaskId) {
				var payload map[string]any
				if err := json.Unmarshal([]byte(kernelString(row["data"])), &payload); err != nil {
					panic(err)
				}
				text := stringField(payload, "text")
				if text == "" {
					text = stringField(payload, "request")
				}
				version := 1
				if value, ok := payload["requirementVersion"].(float64); ok {
					version = int(value)
				}
				messages = append(messages, OperationMessage{Text: text, RequirementVersion: version})
			}
		}
		latest := kernelRow(e.store.Db, "SELECT spec FROM proposals WHERE task_id=? AND version=?", node.TaskId, task.LatestProposal)
		var proposal *NativeProposal
		if latest != nil {
			var parsed NativeProposal
			if err := json.Unmarshal([]byte(kernelString(latest["spec"])), &parsed); err != nil {
				panic(err)
			}
			proposal = &parsed
		}
		var agentContext *ResolvedAgentContext
		if spec.Kind == "agent" {
			resolved := ResolveAgentContext(e.store, ResolveAgentContextInput{
				TaskId: node.TaskId,
				NodeId: node.Id,
				Spec:   spec,
			})
			agentContext = &resolved
		}
		operationWakes := []OperationWake{}
		for _, wake := range wakes {
			operationWakes = append(operationWakes, OperationWake{
				Kind:      string(wake.Kind),
				DedupeKey: wake.DedupeKey,
				TaskId:    wake.TaskID,
				Data:      wake.Data,
			})
		}
		var previousOutput Json
		if node.Output != nil {
			previousOutput = parseJSON(*node.Output)
		}
		proposalVersion := 0
		if task.AcceptedProposal != nil {
			proposalVersion = int(*task.AcceptedProposal)
		}
		intent := OperationIntent{
			TaskId:             node.TaskId,
			NodeId:             node.Id,
			InstanceId:         node.InstanceId,
			Kind:               spec.Kind,
			Action:             spec.Action,
			Input:              spec.Input,
			Dependencies:       map[string]Json{},
			ProposalVersion:    proposalVersion,
			RequirementVersion: int(task.RequirementVersion),
			Context: OperationContext{
				PreviousOutput:  previousOutput,
				RsiContinuation: rsiContinuation,
				Wakes:           operationWakes,
				Answers:         answers,
				Messages:        messages,
			},
			Grants:            grants,
			ActivationId:      node.ActivationId,
			GraphVersion:      int(task.GraphVersion),
			DependencySources: map[string][]DependencySource{},
			InputVersions:     map[string][]InputVersion{},
			Workspace:         workspace,
		}
		var conversationStatus *string
		if conversation != nil {
			status := ConversationDigest(e.store, conversation.Id)
			conversationStatus = &status
		}
		extra := BriefingExtra{
			Request:      task.Request,
			Acceptance:   []AcceptanceItem{},
			Conversation: conversationStatus,
		}
		if proposal != nil {
			summary := proposal.Summary
			extra.Summary = &summary
			extra.Acceptance = proposal.Acceptance
		}
		if task.DecisionDigest != nil {
			decisions := *task.DecisionDigest
			extra.Decisions = &decisions
		}
		if e.catalog != nil {
			var capabilities []BriefingCapability
			if spec.DefinitionVersion != nil && *spec.DefinitionVersion != "" {
				definition, definitionFailure := func() (definition CatalogDefinition, failure any) {
					defer func() {
						if recovered := recover(); recovered != nil {
							failure = recovered
						}
					}()
					return e.catalog.Definition(*spec.DefinitionVersion), nil
				}()
				if definitionFailure == nil {
					for _, binding := range definition.Capabilities {
						capabilities = append(capabilities, BriefingCapability{Id: binding.Id, Version: binding.Version})
					}
				}
			}
			if len(capabilities) > 0 {
				extra.Capabilities = capabilities
			}
			if spec.Role != nil && *spec.Role == "master" {
				definitions := []string{}
				for _, item := range e.catalog.AvailableAgentDefinitions() {
					definitions = append(definitions, item.Id+"@"+itoa(int(item.Version)))
				}
				combinations := []BriefingAgentCombination{}
				for _, item := range e.catalog.AgentCombinations() {
					combinations = append(combinations, BriefingAgentCombination{
						Id:          item.Id,
						Name:        item.Name,
						Description: item.Description,
						Status:      item.Status,
					})
				}
				extra.Catalog = &BriefingCatalog{Definitions: definitions, AgentCombinations: combinations}
				if e.systemContext != nil {
					extra.SystemContext = &BriefingSystemContext{
						Resources:         e.systemContext.Resources,
						AgentCombinations: e.systemContext.AgentCombinations,
						SystemSummary:     e.systemContext.SystemSummary,
					}
				}
			}
		} else if spec.Role != nil && *spec.Role == "master" && e.systemContext != nil {
			extra.SystemContext = &BriefingSystemContext{
				Resources:         e.systemContext.Resources,
				AgentCombinations: e.systemContext.AgentCombinations,
				SystemSummary:     e.systemContext.SystemSummary,
			}
		}
		provisional := intent.operation("", 0, 0)
		briefing, setupLength := Briefing(provisional, extra)
		outputSchema := SchemaRef{Kind: "agent_result", Version: 1}
		intent.Context.OutputSchema = &outputSchema
		userRework := kernelRows(e.store.Db, "SELECT text,data FROM node_entries WHERE task_id=? AND node_id=? AND json_extract(data,'$.reworkActivation')=? ORDER BY seq", node.TaskId, node.Id, node.ActivationId)
		parts := []string{}
		for _, message := range userRework {
			from := ""
			if message["data"] != nil {
				var data map[string]any
				if err := json.Unmarshal([]byte(kernelString(message["data"])), &data); err == nil {
					from = stringField(data, "from")
				}
			}
			if from != "" {
				parts = append(parts, "Peer Agent "+from+" messaged you; treat this as an instruction for this turn and address it in your existing session:\n"+kernelString(message["text"]))
			} else {
				parts = append(parts, "User requested rework of this node and its downstream results. Continue in your existing session and address this message:\n"+kernelString(message["text"]))
			}
		}
		parts = append(parts, briefing)
		if conversation != nil && IsSummaryLeakRetry(intent.Context.PreviousOutput) {
			parts = append(parts, "上一轮输出了内部会话摘要，没有回答用户。请沿用现有会话，完成上一轮用户的原始请求，只给用户正式答复；不要输出 <analysis>、<summary> 或交接摘要。已完成的调查和工具调用无需重复。")
		}
		if conversation != nil && IsUnfinishedToolCalls(intent.Context.PreviousOutput) {
			parts = append(parts, "上一轮的回复在还有工具调用没完成、或者没有给出文字答复时就停了。本轮不要重述已经查到的内容：有没跑完的工具调用就先补做；否则直接根据已有结果给用户正式答复。")
		}
		if len(wakes) > 0 {
			parts = append(parts, RenderWakes(wakes))
		}
		if rsiContinuation != nil {
			parts = append(parts, "RSI reload confirmed for "+rsiContinuation.Commit+" (request "+rsiContinuation.RequestId+"). Resume the unfinished user request from operation "+rsiContinuation.OperationId+" using the existing session. Completed changes and tool results remain valid. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.")
		}
		if pauseContinuation != nil {
			parts = append(parts, "The user paused this task and has now resumed it (request "+pauseContinuation.RequestId+"). Continue the exact turn that was soft-stopped at operation "+pauseContinuation.OperationId+" using the existing session: the in-flight tool call finished, so do not repeat completed tool calls or restart the request. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.")
		}
		kept := []string{}
		for _, part := range parts {
			if part != "" {
				kept = append(kept, part)
			}
		}
		joined := strings.Join(kept, "\n\n")
		intent.Context.Briefing = &joined
		if setupLength > 0 {
			intent.Context.BriefingSetupLength = &setupLength
		}
		if agentContext != nil {
			handoff := ContextHandoffPackage{
				Mode:             agentContext.Mode,
				Purpose:          agentContext.Purpose,
				Independence:     agentContext.Independence,
				RequestedFacts:   agentContext.RequestedFacts,
				ReasonCode:       agentContext.ReasonCode,
				SourceNodeId:     nil,
				SourceInstanceId: nil,
				SourceSessionId:  nil,
				SourceLeafId:     agentContext.SourceLeafId,
				Summary:          task.Request,
				Decisions:        []string{},
				Acceptance:       []AcceptanceItem{},
				ArtifactRefs:     []ArtifactReference{},
				OutputSchema:     outputSchema,
				Briefing:         joined,
			}
			if proposal != nil {
				handoff.Summary = proposal.Summary
				handoff.Decisions = proposal.Decisions
				handoff.Acceptance = proposal.Acceptance
			}
			if task.DecisionDigest != nil {
				handoff.Decisions = []string{*task.DecisionDigest}
			}
			handoffPackage = &handoff
			handoffDigest := contextDigest(handoff)
			constraintsDigest := HandoffConstraintsDigest(handoff)
			updated := *agentContext
			updated.HandoffDigest = handoffDigest
			updated.ConstraintsDigest = constraintsDigest
			intent.Context.AgentContext = &updated
		}
		operation = e.lifecycle.Admit(OperationAdmitInput{
			Node:        OperationNode{Id: node.Id, TaskId: node.TaskId, ActivationId: node.ActivationId},
			Reservation: reservation,
			Prepare: func(attempt int) OperationIntent {
				return intent
			},
			AfterIntent: func(store *TaskStore, admitted Operation) {
				ConsumeRsiContinuation(store, admitted)
				ConsumePauseContinuation(store, admitted.TaskId, admitted.NodeId, admitted.Id)
				if len(answerQuestionIDs) > 0 {
					store.MarkAnswersDelivered(answerQuestionIDs, admitted.Id, NowMillis())
				}
				resolved := admitted.Context.AgentContext
				if resolved != nil && handoffPackage != nil {
					FreezeContextHandoff(store, *resolved, FreezeContextHandoffInput{
						TaskId:      admitted.TaskId,
						OperationId: admitted.Id,
						NodeId:      admitted.NodeId,
						InstanceId:  *admitted.InstanceId,
						Package:     *handoffPackage,
					})
					store.Event(admitted.TaskId, "context.requested", map[string]any{
						"nodeId":       admitted.NodeId,
						"operationId":  admitted.Id,
						"purpose":      string(resolved.Purpose),
						"independence": string(resolved.Independence),
						"sourceNodeId": nil,
					})
					store.Event(admitted.TaskId, "context.mode_selected", map[string]any{
						"nodeId":           admitted.NodeId,
						"operationId":      admitted.Id,
						"mode":             string(resolved.Mode),
						"reasonCode":       resolved.ReasonCode,
						"sourceInstanceId": nil,
					})
					store.Event(admitted.TaskId, "context.handoff_frozen", map[string]any{
						"nodeId":            admitted.NodeId,
						"operationId":       admitted.Id,
						"handoffId":         resolved.HandoffId,
						"digest":            resolved.HandoffDigest,
						"constraintsDigest": resolved.ConstraintsDigest,
					})
				}
				if conversation != nil && len(chatMessages) > 0 {
					DeliverMessages(store, admitted.Id, admitted.Attempt, chatMessages)
				}
			},
		})
		return operation, true, nil
	}()
	if failure != nil {
		if refusal, ok := failure.(*RuntimeError); ok && strings.HasPrefix(refusal.Code, "context_") {
			data := map[string]any{
				"reason":        refusal.Message,
				"code":          refusal.Code,
				"requiredFacts": []any{},
				"policy":        "none",
			}
			e.store.Transaction(func(tx *TaskStore) any {
				lifecycle := e.lifecycle.scoped(tx)
				tx.Event(node.TaskId, "context.rejected", map[string]any{"nodeId": node.Id, "data": data})
				lifecycle.Block(node.TaskId, node.Id, "context_rejected", data, nil)
				return nil
			})
			return Operation{}, false
		}
		panic(failure)
	}
	return operation, admitted
}

func stringField(record map[string]any, key string) string {
	if value, ok := record[key].(string); ok {
		return value
	}
	return ""
}

func optionalStringField(record map[string]any, key string) *string {
	if value, ok := record[key].(string); ok {
		return &value
	}
	return nil
}

func numberField(record map[string]any, key string) float64 {
	if value, ok := record[key].(float64); ok {
		return value
	}
	return 0
}
