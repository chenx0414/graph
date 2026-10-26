package graph

import (
	"database/sql"
)

type TokenBudget struct {
	Budget    float64 `json:"budget"`
	Unlimited bool    `json:"unlimited"`
}

// RevisionRow is one immutable graph definition.
type RevisionRow struct {
	TaskId     string
	Version    int
	Definition GraphDefinition
	Reason     string
	CreatedAt  int64
}

// DeliveryRow is one accepted value landing.
type DeliveryRow struct {
	Id              string  `json:"id"`
	TaskId          string  `json:"taskId"`
	SubmissionId    *string `json:"submissionId"`
	EdgeId          *string `json:"edgeId"`
	FromEndpoint    string  `json:"fromEndpoint"`
	ToEndpoint      string  `json:"toEndpoint"`
	Value           any     `json:"value"`
	Protocol        string  `json:"protocol"`
	RevisionVersion int     `json:"revisionVersion"`
	Seq             int64   `json:"seq"`
	State           string  `json:"state"`
	Source          string  `json:"source"`
	CreatedAt       int64   `json:"createdAt"`
}

// DeliveryEdge is one endpoint pair that work has travelled over.
type DeliveryEdge struct {
	From string
	To   string
}

// ExecutionRow is one node attempt.
//
// The JSON names are the ones the graph views read: an execution history page
// hands these records to a reader that asks for `retriesUsed`, not
// `RetriesUsed`.
type ExecutionRow struct {
	Id              string       `json:"id"`
	TaskId          string       `json:"taskId"`
	NodeId          string       `json:"nodeId"`
	RevisionVersion int          `json:"revisionVersion"`
	Attempt         int          `json:"attempt"`
	RetriesUsed     int          `json:"retriesUsed"`
	ResubmitsUsed   int          `json:"resubmitsUsed"`
	PendingGap      []string     `json:"pendingGap"`
	TokenBudget     *TokenBudget `json:"tokenBudget"`
	State           string       `json:"state"`
	SubmissionId    *string      `json:"submissionId"`
	MissingRequired bool         `json:"missingRequired"`
	StartedAt       int64        `json:"startedAt"`
	EndedAt         *int64       `json:"endedAt"`
}

// SubmitOutput is one named output in a submission.
type SubmitOutput struct {
	Enable bool `json:"enable"`
	Value  any  `json:"value,omitempty"`
}

// SubmitRequest is one execution's output set.
type SubmitRequest struct {
	Outputs      map[string]SubmitOutput
	SubmissionId string
}

// SubmitReceipt is the durable result of submit.
type SubmitReceipt struct {
	SubmissionId string
	Replayed     bool
	Deliveries   []DeliveryRow
	NoRecipients bool
}

// QueueRow is one serial node input.
type QueueRow struct {
	Seq        int64   `json:"seq"`
	TaskId     string  `json:"taskId"`
	NodeId     string  `json:"nodeId"`
	Kind       string  `json:"kind"`
	Payload    any     `json:"payload"`
	Generation int64   `json:"generation"`
	Reason     *string `json:"reason"`
	State      string  `json:"state"`
	CreatedAt  int64   `json:"createdAt"`
}

// NodeStateRow is the per-node retry and pause counters.
type NodeStateRow struct {
	Attempts         int
	ResubmitsUsed    int
	RetriesAllowed   *int
	ResubmitsAllowed *int
	Paused           bool
	Rebinds          int
}

// DirectDelivery is a main-agent input and its landing.
type DirectDelivery struct {
	Delivery DeliveryRow `json:"delivery"`
	Queue    *QueueRow   `json:"queue,omitempty"`
}

// AdmitNodeInput records the instance a node is admitted with.
type AdmitNodeInput struct {
	InstanceId string
	InstanceID string
	Kind       string
}

// AdmitModuleInput records a module's type and trigger.
type AdmitModuleInput struct {
	ModuleType string
	Trigger    string
}

// StartExecutionRequest opens or resumes one execution.
type StartExecutionRequest struct {
	ExecutionId     string
	NodeId          string
	RevisionVersion int
	TokenBudget     *TokenBudget
}

// QueueInsert is one queue append.
type QueueInsert = struct {
	NodeId  string
	Kind    string
	Payload any
}

// KernelNodeView is one admitted node.
type KernelNodeView struct {
	NodeId          string `json:"nodeId"`
	InstanceId      string `json:"instanceId"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	RevisionVersion int    `json:"revisionVersion"`
}

// NodeBudgetState is the spent and held tokens of one node.
type NodeBudgetState struct {
	Budget    float64
	Unlimited bool
	Used      float64
	Reserved  float64
}

// KernelProviderCall is one actual provider send.
//
// The JSON names are the ones a reader of the graph sees: `provider_calls` and
// the node run view both read these records as they are stored, and a record
// without tags would answer `State` where the reader asks for `state`.
type KernelProviderCall struct {
	Id          string             `json:"id"`
	NodeId      string             `json:"nodeId"`
	ExecutionId string             `json:"executionId"`
	Reserved    int64              `json:"reserved"`
	State       string             `json:"state"`
	Usage       *TokenUsage        `json:"usage"`
	Model       *providerCallModel `json:"model"`
	Purpose     string             `json:"purpose"`
	Cost        any                `json:"cost"`
	CreatedAt   int64              `json:"createdAt"`
	SettledAt   *int64             `json:"settledAt"`
}

// ModuleInputRow is the latest value of one module input.
type ModuleInputRow struct {
	ModuleId  string
	Name      string
	Delivered bool
	Value     any
	Source    *string
	UpdatedAt int64
}

// ModuleTransitionInput is one module judgment.
type ModuleTransitionInput struct {
	ModuleId    string
	InputName   string
	InputValue  any
	StateBefore any
	StateAfter  any
	Verdict     *string
	Outputs     map[string]any
	RuleVersion int
	Reason      string
}

// ModuleTransitionRow is a stored judgment.
type ModuleTransitionRow struct {
	ModuleTransitionInput
	Id        string
	CreatedAt int64
}

// HistoryQuery pages queue or execution facts.
type HistoryQuery struct {
	NodeId *string
	After  *int
	Limit  *int
}

// QueueHistoryPage is one queue page.
type QueueHistoryPage struct {
	Items []QueueRow `json:"items"`
	Next  *int64     `json:"next"`
}

// ExecutionHistoryItem is one frozen execution plus its cursor.
type ExecutionHistoryItem struct {
	Cursor int64 `json:"cursor"`
	ExecutionRow
}

// ExecutionHistoryPage is one execution page.
type ExecutionHistoryPage struct {
	Items []ExecutionHistoryItem `json:"items"`
	Next  *int64                 `json:"next"`
}

// CreateRequest is one request to create an independently owned graph.
type CreateRequest struct {
	OwnerTaskID string
	RequestID   string
	GraphID     string
	Content     string
	State       string
}

// KernelStore is the v2 durable layer on the shared task database.
type KernelStore struct {
	Store                   *TaskStore
	Db                      *sql.DB
	DB                      *sql.DB
	Content                 *KernelContent
	moduleTransactionActive bool
}
