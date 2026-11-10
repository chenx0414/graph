package graph

import (
	"regexp"

	"encoding/json"
)

type NodeCapabilityView struct {
	ID         string   `json:"id"`
	Version    string   `json:"version"`
	Kind       *string  `json:"kind"`
	Name       string   `json:"name"`
	Tools      []string `json:"tools"`
	Bound      bool     `json:"bound"`
	Loaded     *bool    `json:"loaded"`
	Executable *bool    `json:"executable"`
	State      string   `json:"state"`
	Reason     *string  `json:"reason"`
}

type NodeRunNode struct {
	ID                string          `json:"id"`
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	Role              *string         `json:"role"`
	Status            string          `json:"status"`
	ActivationID      *string         `json:"activationId"`
	OutputVersion     int64           `json:"outputVersion"`
	StallCount        int64           `json:"stallCount"`
	DefinitionVersion *string         `json:"definitionVersion,omitempty"`
	Input             json.RawMessage `json:"input,omitempty"`
}

type NodeRunInstance struct {
	ID                string   `json:"id"`
	Model             *string  `json:"model"`
	DefinitionVersion *string  `json:"definitionVersion"`
	Used              int64    `json:"used"`
	Budget            *int64   `json:"budget"`
	Unlimited         bool     `json:"unlimited"`
	ModelsUsed        []string `json:"modelsUsed"`
}

type NodeRunSession struct {
	SessionID   string  `json:"sessionId"`
	SessionFile *string `json:"sessionFile"`
}

type NodeRunInvocation struct {
	ID          string      `json:"id"`
	Model       string      `json:"model"`
	Purpose     string      `json:"purpose"`
	Usage       *TokenUsage `json:"usage"`
	UsageSource UsageSource `json:"usageSource"`
	Cost        Json        `json:"cost"`
}

type NodeRunQuestion struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Data   Json   `json:"data"`
}

type NodeRunQueued struct {
	Seq       int64  `json:"seq"`
	Text      string `json:"text"`
	CreatedAt int64  `json:"createdAt"`
}

type NodeRunEvidence struct {
	AcceptanceID string  `json:"acceptanceId"`
	Valid        bool    `json:"valid"`
	CommitSha    *string `json:"commitSha"`
}

type NodeThroughput struct {
	OutputTokens    *int64   `json:"outputTokens"`
	LatencyMs       *int64   `json:"latencyMs"`
	TokensPerSecond *float64 `json:"tokensPerSecond"`
	FirstTokenMs    *int64   `json:"firstTokenMs"`
	UploadMs        *int64   `json:"uploadMs"`
	ServerWaitMs    *int64   `json:"serverWaitMs"`
}

type NodeRunTiming struct {
	TotalMs    *int64 `json:"totalMs"`
	RunMs      *int64 `json:"runMs"`
	WaitingMs  int64  `json:"waitingMs"`
	PauseMs    *int64 `json:"pauseMs"`
	UserWaitMs *int64 `json:"userWaitMs"`
	InProgress bool   `json:"inProgress"`
}

type NodeRunView struct {
	TaskID           string                `json:"taskId"`
	NodeID           string                `json:"nodeId"`
	Context          *ContextFacts         `json:"context"`
	Capabilities     []NodeCapabilityView  `json:"capabilities"`
	CapabilityUsage  []CapabilityUsageFact `json:"capabilityUsage"`
	CapabilityDigest *string               `json:"capabilityDigest"`
	Node             NodeRunNode           `json:"node"`
	Instance         *NodeRunInstance      `json:"instance"`
	Session          *NodeRunSession       `json:"session"`
	Operations       []OperationRun        `json:"operations"`
	Invocations      []NodeRunInvocation   `json:"invocations"`
	Questions        []NodeRunQuestion     `json:"questions"`
	Queued           []NodeRunQueued       `json:"queued"`
	Evidence         []NodeRunEvidence     `json:"evidence"`
	Timing           NodeRunTiming         `json:"timing"`
	Throughput       NodeThroughput        `json:"throughput"`
	Entries          []NodeEntry           `json:"entries"`
	EntryCount       int                   `json:"entryCount"`
	HasOlder         bool                  `json:"hasOlder"`
	HasNewer         bool                  `json:"hasNewer"`
	Phase            string                `json:"phase"`
}

type nodeRunSpec struct {
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	DefinitionVersion *string         `json:"definitionVersion"`
	Role              *string         `json:"role"`
	Input             json.RawMessage `json:"input"`
}

type nodeRunDefinitionSpec struct {
	Capabilities []struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	} `json:"capabilities"`
	Prompts *struct {
		Agent *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"agent"`
		Tool *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"tool"`
	} `json:"prompts"`
}

type nodeRunBinding struct {
	ID      string
	Version string
}

var nodeRunDefinitionMatch = regexp.MustCompile(`^(.*)@(\d+)$`)
