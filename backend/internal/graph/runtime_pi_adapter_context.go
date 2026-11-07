package graph

import ()

type PiAdapterArtifactService struct {
	Access  any
	List    func(query ArtifactQuery) ArtifactPage
	Get     func(artifactId string, version *int) ArtifactRecord
	Read    func(artifactId string, version int, maxBytes int) ArtifactRead
	Publish func(input PublishArtifactInput) ArtifactRecord
	Retire  func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	Promote func(input ArtifactPromoteInput) ArtifactRecord
}

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
			return options.Artifacts.Get(operation.TaskId, artifactId, version, "")
		},
		Read: func(artifactId string, version int, maxBytes int) ArtifactRead {
			return options.Artifacts.Read(operation.TaskId, artifactId, version, maxBytes, "")
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

func piAdapterCompletionSequence(store *TaskStore, instanceId string) int64 {
	row, _ := graphDBRow(store.Db, "SELECT COALESCE(MAX(rowid),0) AS sequence FROM invocations WHERE instance_id=? AND purpose='completion'", instanceId)
	return graphDBInt(row, "sequence")
}

func piAdapterCompactionSettings(entry ModelEntry) *CompactionSettings {
	settings := CompactionSettingsFor(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens})
	return &settings
}

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

func piAdapterGateSendGate(gate *TaskSendGate) SendGate {
	return gate.SendGate
}
