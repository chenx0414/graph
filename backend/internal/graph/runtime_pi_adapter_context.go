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
	settings := compactionSettingsFor(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens})
	return &settings
}

func piAdapterGateSendGate(gate *TaskSendGate) SendGate {
	return gate.SendGate
}
