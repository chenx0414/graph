package graph

import (
	"strings"
)

type PiAdapterArtifactService struct {
	Access  any
	List    func(query ArtifactQuery) ArtifactPage
	Get     func(artifactId string, version *int) ArtifactRecord
	Read    func(artifactId string, version int, maxBytes int) ArtifactRead
	Publish func(input PublishArtifactInput) ArtifactRecord
	Retire  func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	Promote func(input ArtifactPromoteInput) ArtifactRecord
}

// piAdapterArtifactService is the artifact surface one operation may use.
func piAdapterArtifactService(options PiAdapterOptions, input piAdapterRunInput, spec NodeSpec, workspace string, role string) *PiAdapterArtifactService {
	if options.Artifacts == nil {
		return nil
	}
	operation := input.Operation
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	service := &PiAdapterArtifactService{
		Access: AgentArtifactAccessFor(struct {
			Role   string
			Action string
		}{Role: role, Action: spec.Action}),
		List: func(query ArtifactQuery) ArtifactPage {
			query.TaskId = operation.TaskId
			return options.Artifacts.List(query)
		},
		Get: func(artifactId string, version *int) ArtifactRecord {
			return options.Artifacts.Get(operation.TaskId, artifactId, version, "task")
		},
		Read: func(artifactId string, version int, maxBytes int) ArtifactRead {
			return options.Artifacts.Read(operation.TaskId, artifactId, version, maxBytes, "task")
		},
		Publish: func(publish PublishArtifactInput) ArtifactRecord {
			publish.TaskId = operation.TaskId
			publish.Workspace = workspace
			publish.Producer = ArtifactProducer{
				NodeId: operation.NodeId, InstanceId: instanceId, OperationId: operation.Id, ActivationId: operation.ActivationId,
			}
			return options.Artifacts.Publish(publish)
		},
		Retire: func(artifactId string, version int, reason string, requestId string) ArtifactRecord {
			return options.Artifacts.Retire(operation.TaskId, artifactId, version, reason, requestId, map[string]any{
				"nodeId": operation.NodeId, "instanceId": instanceId, "operationId": operation.Id, "activationId": operation.ActivationId,
			})
		},
		Promote: func(promote ArtifactPromoteInput) ArtifactRecord {
			promote.TaskId = operation.TaskId
			promote.PromotedBy = input.DefinitionVersion
			return options.Artifacts.Promote(promote)
		},
	}
	return service
}

// piAdapterCompletionSequence is the last completion sequence number of one instance.
func piAdapterCompletionSequence(store *TaskStore, instanceId string) int64 {
	row, _ := graphDBRow(store.Db, "SELECT COALESCE(MAX(rowid),0) AS sequence FROM invocations WHERE instance_id=? AND purpose='completion'", instanceId)
	return graphDBInt(row, "sequence")
}

// piAdapterLastContextTokens resolves the context size the next turn will send.
func piAdapterLastContextTokens(store *TaskStore, taskId string, instanceId string) *float64 {
	rows := graphDBAll(store.Db, `SELECT i.rowid AS sequence, i.usage, COALESCE(o.settled_at, o.dispatched_at, 0) AS settled_at
       FROM invocations i
       JOIN operations o ON o.id = i.operation_id
       WHERE i.instance_id = ? AND i.purpose = 'completion' AND i.usage IS NOT NULL
       ORDER BY i.rowid DESC LIMIT 20`, instanceId)
	completions := []RecordedContextUsage{}
	for _, row := range rows {
		sequence := asFloatValue(row["sequence"])
		usage, _ := row["usage"].(string)
		settled := asFloatValue(row["settled_at"])
		completions = append(completions, RecordedContextUsage{Usage: usage, SettledAt: settled, Sequence: &sequence})
	}
	var compaction *RecordedCompaction
	last, ok := graphDBRow(store.Db, `SELECT e.timestamp, e.data
       FROM events e
       JOIN operations o ON o.id = json_extract(e.data, '$.operationId')
       WHERE e.task_id = ? AND e.type = 'session.compacted' AND o.instance_id = ?
       ORDER BY e.cursor DESC LIMIT 1`, taskId, instanceId)
	if ok {
		timestamp := asFloatValue(last["timestamp"])
		data, _ := last["data"].(string)
		compaction = &RecordedCompaction{Timestamp: timestamp, Data: data}
	}
	return LatestContextTokens(completions, compaction)
}

// compactionSettingsForEntry derives the compaction thresholds of one model.
func piAdapterCompactionSettings(entry ModelEntry) *CompactionSettings {
	settings := CompactionSettingsFor(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens})
	return &settings
}

// shouldCompactContextForEntry reports whether the context is already too large to send.
func shouldCompactContextForEntry(entry ModelEntry, contextTokens *float64) bool {
	return ShouldCompactContext(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens}, contextTokens)
}

// piAdapterGenerateSuggestion asks one fresh model call for a composer line.
//
// The suggestion is an observer of the turn, never a step in it: a model whose
// credential cannot be resolved, a provider that refuses and a transport that
// fails are facts about the suggestion. None of them may take the reply the
// user already received down with them, so the outcome is reported and the
// turn continues.
func piAdapterGenerateSuggestion(options PiAdapterOptions, entry ModelEntry, gate *TaskSendGate, input piAdapterRunInput, userMessage string, reply string, signal *AbortSignal) (outcome *PromptSuggestionReply) {
	defer func() {
		if recovered := recover(); recovered != nil {
			outcome = &PromptSuggestionReply{Error: promptErrorString(panicMessage(recovered))}
		}
	}()
	store := options.Store
	operation := input.Operation
	systemPrompt := DEFAULT_PROMPT_SUGGESTION_PROMPT
	if options.Channels != nil && options.Channels.AgentContext != nil {
		if prompt, err := options.Channels.AgentContext.Prompt("runtime/prompt-suggestion.md"); err == nil && prompt != "" {
			systemPrompt = prompt
		}
	}
	answer := GeneratePromptSuggestion(struct {
		Stream         PromptStreamFunc
		Model          any
		UserMessage    string
		AssistantReply string
		SystemPrompt   string
		Signal         any
	}{
		Stream: ControlledOpenAIStream(piAdapterGateSendGate(gate), entry, input.ResolveKeyFor, input.SlotFor, entry.Api, PiAdapterStreamOptions{
			EstimateMissing: true,
			OnTransport: func(observation ProviderTransportObservation) {
				data := observation.Fields()
				data["operationId"] = operation.Id
				data["model"] = entry.Id
				store.Event(operation.TaskId, "provider.transport", data)
			},
			OnRequest: func(callId string, profile map[string]any) {
				data := map[string]any{
					"callId": callId, "operationId": operation.Id, "model": entry.Id, "rates": nil, "pricing": nil,
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
		}),
		Model:          ToPiModel(entry),
		UserMessage:    userMessage,
		AssistantReply: reply,
		SystemPrompt:   WithAgentTestingPolicy(systemPrompt, DEFAULT_PROMPT_SUGGESTION_PROMPT),
		Signal:         signal,
	})
	return &answer
}

// piAdapterRunSediment runs the post-operation skill review. It never breaks the turn.
func piAdapterRunSediment(options PiAdapterOptions, input piAdapterRunInput, turn piAdapterTurnInput, entry ModelEntry, reply string, lastUserMessage string) {
	store := options.Store
	operation := input.Operation
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	settings := options.Sediment()
	if !settings.Enabled {
		return
	}
	sedimentEntry := SelectSedimentModel(entry, options.Directory(), settings.Model)
	if sedimentEntry == nil {
		return
	}
	// What this operation itself did. Counting rows in `tool_calls` instead would make the
	// review wait for somebody to open the statistics page.
	toolCalls := len(*turn.ToolActivity)
	material := reply
	if turn.ReloadReceipt != nil && *turn.ReloadReceipt != nil {
		material = RsiChangeMaterial(*turn.ReloadReceipt, reply)
	}
	payload := map[string]any{
		"lastUserMessage": lastUserMessage,
		// An activation turn carries no assistant reply; the change it applied is the material,
		// so the review reads what the turn did instead of an empty string.
		"reply":          truncateRunes(material, 8_000),
		"existingSkills": ExistingSkillSummaries(input.ProjectRoot),
	}
	sedimentSystemPrompt := DEFAULT_SEDIMENT_PROMPT
	if options.Channels != nil && options.Channels.AgentContext != nil {
		if prompt, err := options.Channels.AgentContext.Prompt("runtime/sediment.md"); err == nil && prompt != "" {
			sedimentSystemPrompt = prompt
		}
	}
	sedimentSystemPrompt = WithAgentTestingPolicy(sedimentSystemPrompt, DEFAULT_SEDIMENT_PROMPT)
	// A cheap model is exactly the one whose account can be out of quota, so a refusal is not
	// the end of the review: candidates are asked in order and every attempt is kept, so the
	// record can never show a single silent failure as if it were a decision.
	candidates := SedimentCandidates(entry, options.Directory(), settings.Model)
	attempts := []map[string]any{}
	var answered *string
	var capture *SedimentReply
	defer func() {
		if rec := recover(); rec != nil {
			// A review is an observer of the operation, never a step in it.
			_ = rec
		}
	}()
	sedimentRole := "master"
	decision := RunSedimentReview(SedimentGate{
		Enabled: true, Role: &sedimentRole, ToolCalls: toolCalls,
		Threshold: settings.AfterToolCalls, Paused: store.Task(operation.TaskId).Paused != 0,
		// This block runs once per settled operation, so a second look is impossible here.
		AlreadyReviewed: false,
	}, settings, input.ProjectRoot, func() *string {
		for _, candidate := range candidates {
			candidateNodeId := operation.NodeId
			candidateGate := TaskGate(store, TaskGateOperation{
				Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &candidateNodeId,
			}, candidate, TaskGateOptions{Optional: true})
			candidateGate.SetPurpose("skill_sediment")
			candidateReply := GenerateSkillProposal(
				func(model any, context map[string]any, streamOptions map[string]any) (map[string]any, error) {
					stream, err := ControlledOpenAIStream(piAdapterGateSendGate(candidateGate), candidate, input.ResolveKeyFor, input.SlotFor, candidate.Api, PiAdapterStreamOptions{
						EstimateMissing: true,
						OnTransport: func(observation ProviderTransportObservation) {
							data := observation.Fields()
							data["operationId"] = operation.Id
							data["model"] = candidate.Id
							store.Event(operation.TaskId, "provider.transport", data)
						},
						OnRequest: func(callId string, profile map[string]any) {
							data := map[string]any{
								"callId": callId, "operationId": operation.Id, "model": candidate.Id, "rates": nil, "pricing": nil,
							}
							if candidate.Cost != nil {
								data["rates"] = candidate.Cost
							}
							if candidate.Pricing != nil {
								data["pricing"] = candidate.Pricing
							}
							for key, value := range profile {
								data[key] = value
							}
							store.Event(operation.TaskId, "provider.request_profile", data)
						},
					})(model, context, streamOptions)
					if err != nil {
						return nil, err
					}
					return stream.Result(), nil
				},
				ToPiModel(candidate), sedimentSystemPrompt, payload, nil)
			copied := candidateReply
			capture = &copied
			attempt := map[string]any{"model": candidate.Id, "stopReason": nil, "error": nil, "chars": len([]rune(candidateReply.Raw))}
			if candidateReply.StopReason != nil {
				attempt["stopReason"] = *candidateReply.StopReason
			}
			if candidateReply.Error != nil {
				attempt["error"] = *candidateReply.Error
			}
			attempts = append(attempts, attempt)
			// An account that is out of quota can answer with an empty message that still says
			// "stop": only usable text ends the walk, or the review stops at the refusal.
			usable := ""
			if candidateReply.Text != nil {
				usable = strings.TrimSpace(*candidateReply.Text)
			}
			if usable != "" {
				answered = &candidate.Id
				return &usable
			}
		}
		return nil
	})
	// What the review decided travels with the operation, so "it ran and found nothing",
	// "it proposed and was refused", "it never came back with anything readable" and "every
	// cheap account refused it" are facts in the store instead of guesses.
	model := ""
	if answered != nil {
		model = *answered
	} else if len(candidates) > 0 {
		model = candidates[0].Id
	} else {
		model = sedimentEntry.Id
	}
	record := map[string]any{
		"operationId": operation.Id, "nodeId": operation.NodeId, "model": model, "toolCalls": toolCalls,
		"threshold": settings.AfterToolCalls, "reviewed": decision.Reviewed, "proposed": decision.Outcome.Proposed,
		"written": decision.Outcome.Written, "refused": decision.Outcome.Refused, "attempts": attempts,
		"replyShape": nil, "replyStop": nil, "replyChars": 0, "replyHead": "", "replyError": nil,
	}
	if capture != nil {
		shape := SedimentReplyShapeOf(capture.Raw)
		record["replyShape"] = shape
		if capture.StopReason != nil {
			record["replyStop"] = *capture.StopReason
		}
		record["replyChars"] = len([]rune(capture.Raw))
		record["replyHead"] = truncateRunes(capture.Raw, 200)
		if capture.Error != nil {
			record["replyError"] = *capture.Error
		}
	}
	store.Event(operation.TaskId, "skill_sediment.reviewed", record)
}

// piAdapterGateSendGate is the send gate a task gate offers to the provider transport.
func piAdapterGateSendGate(gate *TaskSendGate) SendGate {
	return gate.SendGate
}
