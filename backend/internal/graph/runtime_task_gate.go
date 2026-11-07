package graph

type InvocationPurpose string

const (
	InvocationCompletion       InvocationPurpose = "completion"
	InvocationCompaction       InvocationPurpose = "compaction"
	InvocationBranchSummary    InvocationPurpose = "branch_summary"
)

var INVOCATION_PURPOSES = []InvocationPurpose{
	InvocationCompletion,
	InvocationCompaction,
	InvocationBranchSummary,
}

type TaskGateOperation struct {
	Id         string
	TaskId     string
	InstanceId string
	NodeId *string
}

type TaskGateOptions struct {
	Optional bool
	Unrestricted bool
}

type TaskSendGate struct {
	SendGate
	store       *TaskStore
	operation   TaskGateOperation
	model       ModelEntry
	options     TaskGateOptions
	nodeId      *string
	unknown     bool
	purpose     InvocationPurpose
	total       TokenUsage
	totalSource *UsageSource
}

func TaskGate(store *TaskStore, operation TaskGateOperation, model ModelEntry, options TaskGateOptions) *TaskSendGate {
	gate := &TaskSendGate{store: store, operation: operation, model: model, options: options, purpose: InvocationCompletion}
	if operation.NodeId != nil {
		gate.nodeId = operation.NodeId
	} else if nodeId, found := store.OperationNode(operation.Id); found {
		gate.nodeId = &nodeId
	}
	gate.SendGate = SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			return gate.dispatch(id, reservation, send)
		},
		Settle: func(id string, usage *TokenUsage) {
			gate.settle(id, usage)
		},
	}
	return gate
}

func (gate *TaskSendGate) hasNode() bool {
	return gate.nodeId != nil && *gate.nodeId != ""
}

func (gate *TaskSendGate) Check(reservation float64) {
	if !jsSafeInteger(reservation) || reservation < 0 {
		Raise("invalid_input", "A token reservation is required")
	}
	task := gate.store.Task(gate.operation.TaskId)
	if task.Phase != "chatting" && projectArchived(gate.store, task.ProjectID) {
		Raise("paused", "Project is archived")
	}
	if gate.options.Unrestricted {
		return
	}
	if gate.store.Task(gate.operation.TaskId).Paused != 0 {
		Raise("paused", "Instance paused")
	}
	if gate.hasNode() &&
		!UnknownUsageIsNonBlocking(gate.store, gate.operation.InstanceId) &&
		gate.store.OpenUnknownUsageQuestion(gate.operation.TaskId, *gate.nodeId) {
		Raise("unknown_usage", "Instance paused for unknown usage")
	}
}

func (gate *TaskSendGate) dispatch(id string, reservation float64, send func() any) any {
	if id == "" {
		Raise("invalid_input", "An invocation id is required")
	}
	gate.Check(reservation)
	modelName := gate.model.ModelId
	if modelName == "" {
		modelName = gate.model.Id
	}
	gate.store.Transaction(func() {
		if gate.store.InvocationExists(id) {
			Raise("invalid_input", "Invocation already dispatched")
		}
		gate.store.OpenInvocation(id, gate.operation.Id, gate.operation.InstanceId, modelName, string(gate.purpose))
	})
	defer func() {
		if recovered := recover(); recovered != nil {
			gate.settle(id, nil)
			panic(recovered)
		}
	}()
	return send()
}

func (gate *TaskSendGate) settle(id string, usage *TokenUsage) {
	gate.store.Transaction(func() {
		settled, found := gate.store.InvocationUsage(id)
		if !found {
			Raise("not_found", "Unknown invocation")
		}
		var normalized *TokenUsage
		if usage != nil {
			value := NormalizeTokenUsage(*usage)
			normalized = &value
		}
		source := UsageSourceOf(normalized)
		if settled != nil {
			claimed := CanonicalJSON(normalized)
			if *settled != claimed {
				Raise("result_conflict", "Conflicting usage evidence for "+id+": recorded "+*settled+", claimed "+claimed)
			}
			return
		}
		accountable := normalized != nil &&
			source != UsageUnknown &&
			(source != UsageEstimated || gate.options.Unrestricted || UnknownUsageIsNonBlocking(gate.store, gate.operation.InstanceId))
		var cost any
		if accountable {
			cost = EstimateCost(*normalized, gate.model.Cost, gate.model.Pricing)
		} else {
			cost = map[string]any{"unknown": true}
		}
		var recorded any
		if normalized != nil {
			recorded = CanonicalJSON(normalized)
		}
		gate.store.RecordInvocationUsage(id, recorded, CanonicalJSON(cost))
		if !accountable {
			gate.unknown = true
			if !gate.options.Optional &&
				!gate.options.Unrestricted &&
				gate.hasNode() &&
				!UnknownUsageIsNonBlocking(gate.store, gate.operation.InstanceId) &&
				!gate.store.OpenUnknownUsageQuestionForOperation(gate.operation.Id) {
				reason := "Agent returned no accountable usage"
				if source == UsageEstimated {
					reason = "Agent returned only estimated usage for a finite budget"
				}
				operationID := gate.operation.Id
				InsertQuestion(gate.store, QuestionInput{
					TaskId:      gate.operation.TaskId,
					NodeId:      *gate.nodeId,
					OperationId: &operationID,
					Kind:        "unknown_usage",
					Data:        map[string]any{"reason": reason, "usageSource": string(source)},
				})
			}
			return
		}
		if normalized == nil {
			return
		}
		gate.total.Input += normalized.Input
		gate.total.Output += normalized.Output
		gate.total.CacheRead += normalized.CacheRead
		gate.total.CacheWrite += normalized.CacheWrite
		if gate.totalSource == nil {
			value := source
			gate.totalSource = &value
			return
		}
		merged := MergeUsageSource(*gate.totalSource, source)
		gate.totalSource = &merged
	})
}

func (gate *TaskSendGate) SetPurpose(purpose InvocationPurpose) {
	known := false
	for _, candidate := range INVOCATION_PURPOSES {
		if candidate == purpose {
			known = true
			break
		}
	}
	if !known {
		Raise("invalid_input", "Unknown invocation purpose "+string(purpose))
	}
	gate.purpose = purpose
}

func (gate *TaskSendGate) Total() *TokenUsage {
	if gate.unknown {
		return nil
	}
	total := gate.total
	source := string(UsageAuthoritative)
	if gate.totalSource != nil {
		source = string(*gate.totalSource)
	}
	total.UsageSource = &source
	return &total
}

func InvocationRows(store *TaskStore, taskId string) []InvocationRow {
	return store.InvocationRows(taskId)
}
