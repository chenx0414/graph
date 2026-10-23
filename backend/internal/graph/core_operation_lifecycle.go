package graph

import (
	"encoding/json"
	"regexp"
	"strings"
)

// OperationNode identifies the node an operation belongs to.
type OperationNode struct {
	Id           string
	TaskId       string
	ActivationId string
}

// OperationIntent is the operation without its identity: id, generation and attempt
// are assigned by the lifecycle when the intent becomes durable.
type OperationIntent struct {
	TaskId             string
	NodeId             string
	InstanceId         *string
	Kind               string
	Action             string
	Input              Json
	Dependencies       map[string]Json
	ProposalVersion    int
	RequirementVersion int
	Context            OperationContext
	Grants             []string
	AccessPolicy       *ResolvedAccessPolicy
	ActivationId       string
	GraphVersion       int
	DependencySources  map[string][]DependencySource
	InputVersions      map[string][]InputVersion
	Workspace          *string
}

// operation materializes the intent as the durable operation.
func (intent OperationIntent) operation(id string, generation, attempt int) Operation {
	dependencies := intent.Dependencies
	if dependencies == nil {
		dependencies = map[string]Json{}
	}
	dependencySources := intent.DependencySources
	if dependencySources == nil {
		dependencySources = map[string][]DependencySource{}
	}
	inputVersions := intent.InputVersions
	if inputVersions == nil {
		inputVersions = map[string][]InputVersion{}
	}
	grants := intent.Grants
	if grants == nil {
		grants = []string{}
	}
	return Operation{
		Id:                 id,
		TaskId:             intent.TaskId,
		NodeId:             intent.NodeId,
		InstanceId:         intent.InstanceId,
		Generation:         generation,
		Attempt:            attempt,
		Kind:               intent.Kind,
		Action:             intent.Action,
		Input:              intent.Input,
		Dependencies:       dependencies,
		ProposalVersion:    intent.ProposalVersion,
		RequirementVersion: intent.RequirementVersion,
		Context:            intent.Context,
		Grants:             grants,
		AccessPolicy:       intent.AccessPolicy,
		ActivationId:       intent.ActivationId,
		GraphVersion:       intent.GraphVersion,
		DependencySources:  dependencySources,
		InputVersions:      inputVersions,
		Workspace:          intent.Workspace,
	}
}

// OperationIntentEvent is what an `operation.intent` event carries: enough to identify
// the operation in a timeline, and nothing else.
func OperationIntentEvent(operation Operation) map[string]any {
	return map[string]any{
		"operationId":        operation.Id,
		"taskId":             operation.TaskId,
		"nodeId":             operation.NodeId,
		"instanceId":         operation.InstanceId,
		"generation":         operation.Generation,
		"attempt":            operation.Attempt,
		"kind":               operation.Kind,
		"action":             operation.Action,
		"proposalVersion":    operation.ProposalVersion,
		"requirementVersion": operation.RequirementVersion,
		"specRef":            "operations.spec",
	}
}

// OperationSnapshot is one operation row plus its parsed state.
type OperationSnapshot struct {
	Id           string           `json:"id"`
	Operation    Operation        `json:"operation"`
	State        string           `json:"state"`
	Reserved     int64            `json:"reserved"`
	WorkerActive bool             `json:"workerActive"`
	Result       *OperationResult `json:"result"`
	DispatchedAt *int64           `json:"dispatchedAt"`
	SettledAt    *int64           `json:"settledAt"`
}

// OperationRun is the per-node run projection.
type OperationRun struct {
	Id           string  `json:"id"`
	State        string  `json:"state"`
	ActivationId *string `json:"activationId"`
	WorkerActive bool    `json:"workerActive"`
	WaitingSlot  bool    `json:"waitingSlot"`
	Reserved     int64   `json:"reserved"`
	WaitingMs    int64   `json:"waitingMs"`
	RunMs        *int64  `json:"runMs"`
	DispatchedAt *int64  `json:"dispatchedAt"`
	SettledAt    *int64  `json:"settledAt"`
	Result       Json    `json:"result"`
	Usage        Json    `json:"usage"`
}

// OperationLifecycleHooks lets the host veto a replay before the adapter sent anything.
type OperationLifecycleHooks struct {
	CanReplayBeforeSend func(operation Operation) bool
}

// OperationAdmitInput is one admission of an operation.
type OperationAdmitInput struct {
	Node        OperationNode
	Reservation int64
	Prepare     func(attempt int) OperationIntent
	AfterIntent func(operation Operation)
}

// OperationQuery selects operation rows.
type OperationQuery struct {
	After  *string
	Before *string
	Latest bool
	NodeId *string
	Limit  *int
}

var operationDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// operationInstanceId is the instance of an operation, or the empty string.
func operationInstanceId(operation Operation) string {
	if operation.InstanceId == nil {
		return ""
	}
	return *operation.InstanceId
}

// operationLifecycleStringPtr is the optional-string helper of this file.
func operationLifecycleStringPtr(value string) *string {
	return &value
}

// operationLifecycleTokenTotal is the total of one disjoint token count.
func operationLifecycleTokenTotal(usage TokenUsage) int64 {
	return TokenUsageTotal(usage)
}

// operationFrom parses the stored operation spec.
func operationFrom(row map[string]any) Operation {
	var operation Operation
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &operation); err != nil {
		panic(err)
	}
	return operation
}

// describeFailure flattens the words a failed operation left behind, so the
// environment-failure predicate sees text instead of a shape.
func describeFailure(output Json) string {
	if output == nil {
		return ""
	}
	if text, ok := output.(string); ok {
		return text
	}
	record, ok := jsonRecord(output)
	if !ok {
		return jsonStringify(output)
	}
	parts := []string{}
	for _, key := range []string{"error", "stderr", "stdout", "message", "reason"} {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n")
	}
	return jsonStringify(output)
}

// sumKnownUsage adds the known usage rows and keeps the weakest provenance.
func sumKnownUsage(rows []map[string]any) TokenUsage {
	total := TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0}
	var source *UsageSource
	for _, row := range rows {
		text := kernelString(row["usage"])
		if text == "" {
			unknown := UsageUnknown
			if source == nil {
				source = &unknown
			} else {
				merged := MergeUsageSource(*source, UsageUnknown)
				source = &merged
			}
			continue
		}
		var usage TokenUsage
		if err := json.Unmarshal([]byte(text), &usage); err != nil {
			panic(err)
		}
		total.Input += usage.Input
		total.Output += usage.Output
		total.CacheRead += usage.CacheRead
		total.CacheWrite += usage.CacheWrite
		next := UsageSourceOf(&usage)
		if source == nil {
			value := next
			source = &value
		} else {
			value := MergeUsageSource(*source, next)
			source = &value
		}
	}
	if source == nil {
		unknown := string(UsageUnknown)
		total.UsageSource = &unknown
		return total
	}
	value := string(*source)
	total.UsageSource = &value
	return total
}
