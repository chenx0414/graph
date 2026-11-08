package graph

import (
	"regexp"
	"strings"

	"encoding/json"
)

type OperationNode struct {
	Id           string
	TaskId       string
	ActivationId string
}

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
	ActivationId       string
	GraphVersion       int
	DependencySources  map[string][]DependencySource
	InputVersions      map[string][]InputVersion
	Workspace          *string
}

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
		ActivationId:       intent.ActivationId,
		GraphVersion:       intent.GraphVersion,
		DependencySources:  dependencySources,
		InputVersions:      inputVersions,
		Workspace:          intent.Workspace,
	}
}

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

type CredentialRecoveryRequest struct {
	Model        string
	TaskId       string
	NodeId       string
	OperationId  string
	ActivationId string
	Output       string
}

type OperationLifecycleHooks struct {
	CanReplayBeforeSend func(operation Operation) bool
	OnCredentialRejected func(CredentialRecoveryRequest) bool
}

type OperationAdmitInput struct {
	Node        OperationNode
	Reservation int64
	Prepare     func(attempt int) OperationIntent
	AfterIntent func(operation Operation)
}

type OperationQuery struct {
	After  *string
	Before *string
	Latest bool
	NodeId *string
	Limit  *int
}

var operationDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func operationInstanceId(operation Operation) string {
	if operation.InstanceId == nil {
		return ""
	}
	return *operation.InstanceId
}

func operationLifecycleStringPtr(value string) *string {
	return &value
}

func operationLifecycleTokenTotal(usage TokenUsage) int64 {
	return TokenUsageTotal(usage)
}

func operationFrom(row map[string]any) Operation {
	var operation Operation
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &operation); err != nil {
		panic(err)
	}
	return operation
}

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
