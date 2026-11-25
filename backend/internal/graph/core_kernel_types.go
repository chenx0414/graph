package graph

import (
)

type TokenBudget struct {
	Budget    float64 `json:"budget"`
	Unlimited bool    `json:"unlimited"`
}

type RevisionRow struct {
	TaskId     string
	Version    int
	Definition GraphDefinition
	Reason     string
	CreatedAt  int64
}

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

type DeliveryEdge struct {
	From string
	To   string
}

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

type SubmitOutput struct {
	Enable bool `json:"enable"`
	Value  any  `json:"value,omitempty"`
}

type SubmitRequest struct {
	Outputs      map[string]SubmitOutput
	SubmissionId string
}

type SubmitReceipt struct {
	SubmissionId string
	Replayed     bool
	Deliveries   []DeliveryRow
	NoRecipients bool
}

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

type NodeStateRow struct {
	Attempts         int
	ResubmitsUsed    int
	RetriesAllowed   *int
	ResubmitsAllowed *int
	Paused           bool
	Rebinds          int
}

type DirectDelivery struct {
	Delivery DeliveryRow `json:"delivery"`
	Queue    *QueueRow   `json:"queue,omitempty"`
}

type AdmitNodeInput struct {
	InstanceId string
	InstanceID string
	Kind       string
}

type AdmitModuleInput struct {
	ModuleType string
	Trigger    string
}

type StartExecutionRequest struct {
	ExecutionId     string
	NodeId          string
	RevisionVersion int
	TokenBudget     *TokenBudget
}

type QueueInsert = struct {
	NodeId  string
	Kind    string
	Payload any
}

type KernelNodeView struct {
	NodeId          string `json:"nodeId"`
	InstanceId      string `json:"instanceId"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	RevisionVersion int    `json:"revisionVersion"`
}

type NodeBudgetState struct {
	Budget    float64
	Unlimited bool
	Used      float64
	Reserved  float64
}

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

type ModuleInputRow struct {
	ModuleId  string
	Name      string
	Delivered bool
	Value     any
	Source    *string
	UpdatedAt int64
}

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

type ModuleTransitionRow struct {
	ModuleTransitionInput
	Id        string
	CreatedAt int64
}

type HistoryQuery struct {
	NodeId *string
	After  *int
	Limit  *int
}

type QueueHistoryPage struct {
	Items []QueueRow `json:"items"`
	Next  *int64     `json:"next"`
}

type ExecutionHistoryItem struct {
	Cursor int64 `json:"cursor"`
	ExecutionRow
}

type ExecutionHistoryPage struct {
	Items []ExecutionHistoryItem `json:"items"`
	Next  *int64                 `json:"next"`
}

type CreateRequest struct {
	OwnerTaskID string
	RequestID   string
	GraphID     string
	Content     string
	State       string
}

type KernelStore struct {
	Store                   *TaskStore
	Db                      sqlh
	DB                      sqlh
	Content                 *KernelContent
	moduleTransactionActive bool
}
